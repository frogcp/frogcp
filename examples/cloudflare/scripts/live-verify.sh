#!/usr/bin/env bash
# Live verification of this example against real Cloudflare.
# Provisions a throwaway Worker + D1 + KV, asserts real behaviour over HTTPS,
# and always tears everything down on exit.
#
# Manual tool, not part of `pnpm test` or CI: it needs credentials and creates
# real billable resources. See the README's "Live verification" section.

set -uo pipefail

EX="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
W="$EX/node_modules/.bin/wrangler"
FROGCP="$EX/node_modules/.bin/frogcp"

# Override to run more than one verification at a time without collisions.
NAME="${LIVE_VERIFY_NAME:-frogcp-livetest}"

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] || [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  echo "CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set in the environment." >&2
  exit 1
fi
export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID

# Logs, generated SQL and cookie jars are throwaway. The wrangler configs and
# the migrate-check worker are not: wrangler resolves `main` and the `frogcp`
# import relative to them, so they have to sit in the example and get removed on
# exit instead.
TMP="$(mktemp -d)"
CFG="$EX/wrangler.livetest.jsonc"
CFG_M="$EX/wrangler.livetest-migrate.jsonc"
WORKER_M="$EX/src/worker.migratecheck.ts"

PASS=0; FAIL=0; D1_ID=""; KV_ID=""; R2_NAME=""

ok()  { PASS=$((PASS+1)); printf '  PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL  %s\n     expected: %s\n     actual:   %s\n' "$1" "$2" "${3:0:400}"; }
is()  { [ "$2" = "$3" ] && ok "$1" || bad "$1" "$3" "$2"; }
has() { case "$2" in *"$3"*) ok "$1";; *) bad "$1" "contains: $3" "$2";; esac; }

cleanup() {
  echo ""
  echo "=== teardown ==="
  [ -f "$CFG_M" ] && "$W" delete --config "$CFG_M" >/dev/null 2>&1 && echo "  migrate-check worker deleted"
  [ -f "$CFG" ]   && "$W" delete --config "$CFG"   >/dev/null 2>&1 && echo "  worker deleted"
  [ -n "$D1_ID" ] && "$W" d1 delete "$NAME-db" -y >/dev/null 2>&1 && echo "  d1 deleted"
  [ -n "$KV_ID" ] && "$W" kv namespace delete --namespace-id "$KV_ID" >/dev/null 2>&1 && echo "  kv deleted"
  [ -n "$R2_NAME" ] && "$W" r2 bucket delete "$R2_NAME" >/dev/null 2>&1 && echo "  r2 deleted"
  rm -f "$CFG" "$CFG_M" "$WORKER_M"
  rm -rf "$TMP"
  echo ""
  echo "=== RESULT: $PASS passed, $FAIL failed ==="
  [ "$FAIL" -eq 0 ] || exit 1
}
trap cleanup EXIT

# A newly created workers.dev route is not immediately consistent across edge
# locations. Different colos can serve 404 while the route is not live yet, or
# reject during rollout, so one successful probe does not mean the next request
# lands on a ready colo. Wait for a run of consecutive successes.
wait_for() {  # wait_for <base-url> <acceptable codes...>
  local url="$1"; shift
  local code i want hit streak=0
  for i in $(seq 1 90); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$url/api/system/health")
    hit=0
    for want in "$@"; do [ "$code" = "$want" ] && hit=1; done
    if [ "$hit" = "1" ]; then
      streak=$((streak+1))
      [ "$streak" -ge 6 ] && { sleep 5; return 0; }
    else
      streak=0
    fi
    sleep 2
  done
  echo "  WARN: $url never returned [$*] 6 times consecutively (last=$code)"
  return 1
}

# Cloudflare's edge intermittently rejects requests with its own error page
# (1042, 1101, 1104) that never reaches the worker. That is infrastructure
# noise, not application behaviour, so retry it. A real application response,
# including a 4xx, is never retried.
req() {  # req <curl args...> -> "<status><TAB><body>"
  local out code body i
  for i in 1 2 3 4 5; do
    out=$(curl -s -w $'\n%{http_code}' --max-time 20 "$@")
    code="${out##*$'\n'}"
    body="${out%$'\n'*}"
    case "$body" in *"error code: 10"*) sleep 3; continue;; esac
    printf '%s\t%s' "$code" "$body"
    return 0
  done
  printf '%s\t%s' "$code" "$body"
}
status() { printf '%s' "${1%%$'\t'*}"; }
body()   { printf '%s' "${1#*$'\t'}"; }

write_cfg() {  # write_cfg <path> <worker-name> <entry>
  cat > "$1" <<EOF
{
  "name": "$2",
  "main": "$3",
  "compatibility_date": "2026-07-01",
  "workers_dev": true,
  "d1_databases": [{ "binding": "DB", "database_name": "$NAME-db", "database_id": "$D1_ID" }],
  "kv_namespaces": [{ "binding": "SESSIONS", "id": "$KV_ID" }],
  "r2_buckets": [{ "binding": "BUCKET", "bucket_name": "$R2_NAME" }],
  "vars": {}
}
EOF
}

# The workers.dev subdomain belongs to whichever account the token points at, so
# read the deployed URL back out of wrangler's own output.
deployed_url() {  # deployed_url <deploy-log>
  grep -oE 'https://[a-z0-9.-]+\.workers\.dev' "$1" | head -1
}

cd "$EX" || exit 1
SECRET=$(openssl rand -hex 24)

echo "=== provision ==="
D1_ID=$("$W" d1 create "$NAME-db" 2>&1 | grep -o '"database_id": "[^"]*"' | cut -d'"' -f4)
KV_ID=$("$W" kv namespace create livetest 2>&1 | grep -o '"id": "[^"]*"' | cut -d'"' -f4)
# R2 buckets are addressed by name, so a successful create is all we record. The
# non-empty R2_NAME both flags it for teardown and feeds write_cfg's binding.
if "$W" r2 bucket create "$NAME-media" >/dev/null 2>&1; then R2_NAME="$NAME-media"; fi
[ -n "$D1_ID" ] && [ -n "$KV_ID" ] && [ -n "$R2_NAME" ] || { echo "provisioning failed"; exit 1; }
echo "  d1, kv and r2 created"

# --- Phase 1 -----------------------------------------------------------------
# Forcing migration on a deployed Worker must explain itself rather than failing
# with a raw module-resolution error. Runs under its own worker name so the
# broken version it publishes is never served to the later phases.
echo ""
echo "=== phase 1: migrate on Workers surfaces an actionable error ==="
cat > "$WORKER_M" <<'TS'
import { createWorkerHandler, d1Adapter } from "frogcp/adapter/cloudflare";
import app from "../frogcp.config";
import type { Env } from "./env";

export default createWorkerHandler<Env>({
  config: app.config,
  ...(app.plugins ? { plugins: app.plugins } : {}),
  migrate: true,
  resolve: (env) => ({ adapter: d1Adapter(env.DB) }),
});
TS
write_cfg "$CFG_M" "$NAME-migrate" "src/worker.migratecheck.ts"
printf '%s' "$SECRET" | "$W" secret put AUTH_SECRET --config "$CFG_M" >/dev/null 2>&1
"$W" deploy --config "$CFG_M" > "$TMP/deploy-migrate.log" 2>&1 \
  || echo "  WARN: migrate-check deploy failed: $(tail -3 "$TMP/deploy-migrate.log")"
BASE_M=$(deployed_url "$TMP/deploy-migrate.log")
[ -n "$BASE_M" ] || { echo "could not read the deployed URL from wrangler output"; exit 1; }
wait_for "$BASE_M" 500 200 || true

# `wrangler tail` takes a few seconds to attach and loses events fired before it
# is live, so retry the capture until the worker's exception is seen.
MSG=""
for attempt in 1 2 3; do
  "$W" tail --config "$CFG_M" --format json > "$TMP/tail.log" 2>&1 &
  TAIL_PID=$!
  sleep 8
  for _ in 1 2 3; do curl -s -o /dev/null --max-time 15 "$BASE_M/api/system/health"; sleep 2; done
  sleep 8
  kill "$TAIL_PID" 2>/dev/null
  MSG=$(grep -o '"message": *"[^"]*"' "$TMP/tail.log" | head -1)
  [ -n "$MSG" ] && break
  echo "  (tail attempt $attempt captured nothing, retrying)"
done
echo "  live worker error: ${MSG:0:200}"
case "$MSG" in
  *"migrate: false"*|*"out of band"*) ok "deployed worker explains how to proceed" ;;
  *"No such module"*) bad "deployed worker explains how to proceed" "actionable guidance" "raw module error" ;;
  *) bad "deployed worker explains how to proceed" "actionable guidance" "${MSG:-nothing captured}" ;;
esac
"$W" delete --config "$CFG_M" >/dev/null 2>&1 && echo "  migrate-check worker deleted"
rm -f "$CFG_M" "$WORKER_M"

# --- Phase 2 -----------------------------------------------------------------
# The documented production path: emit DDL, apply it out of band, then deploy.
echo ""
echo "=== phase 2: out-of-band schema, then deploy ==="
write_cfg "$CFG" "$NAME" "src/worker.ts"

"$FROGCP" schema > "$TMP/schema.sql" 2>"$TMP/schema.err"
if [ -s "$TMP/schema.sql" ]; then ok "frogcp schema emitted DDL ($(grep -c 'CREATE' "$TMP/schema.sql") CREATE statements)"
else bad "frogcp schema emitted DDL" "non-empty SQL" "$(head -3 "$TMP/schema.err")"; fi
grep -q "__frogcp_migrations" "$TMP/schema.sql" \
  && bad "schema omits bookkeeping table" "no __frogcp_migrations" "present" \
  || ok "schema omits bookkeeping table"
grep -q 'CREATE TABLE `users`' "$TMP/schema.sql" && ok "schema includes auth plugin entities" \
  || bad "schema includes auth plugin entities" "users table" "missing"

if "$W" d1 execute "$NAME-db" --remote --file "$TMP/schema.sql" --config "$CFG" -y > "$TMP/apply.log" 2>&1
then ok "schema applied to remote D1 in one shot"
else bad "schema applied to remote D1 in one shot" "exit 0" "$(grep -i error "$TMP/apply.log" | head -2)"; fi

# Secret before the first deploy, so no version ever serves without AUTH_SECRET.
printf '%s' "$SECRET" | "$W" secret put AUTH_SECRET --config "$CFG" >/dev/null 2>&1
"$W" deploy --config "$CFG" > "$TMP/deploy.log" 2>&1 \
  || echo "  WARN: deploy failed: $(tail -3 "$TMP/deploy.log")"
BASE=$(deployed_url "$TMP/deploy.log")
[ -n "$BASE" ] || { echo "could not read the deployed URL from wrangler output"; exit 1; }
wait_for "$BASE" 200 || true
# Readiness at one colo does not mean the rollout finished everywhere. Settle
# before asserting, so a colo still holding the previous version is not read as
# an application failure.
sleep 20

# --- Phase 3 -----------------------------------------------------------------
echo ""
echo "=== phase 3: live behaviour ==="

R=$(req "$BASE/api/system/health"); is "health returns 200" "$(status "$R")" "200"

R=$(req -c "$TMP/a.cookies" -X POST "$BASE/api/auth/register" -H 'content-type: application/json' \
  -d '{"email":"alice@example.com","password":"correct-horse-battery-staple"}')
has "first user becomes admin" "$(body "$R")" '"role":"admin"'

R=$(req -c "$TMP/b.cookies" -X POST "$BASE/api/auth/register" -H 'content-type: application/json' \
  -d '{"email":"bob@example.com","password":"another-good-passphrase"}')
has "second user is member" "$(body "$R")" '"role":"member"'

R=$(req -X POST "$BASE/api/auth/register" -H 'content-type: application/json' \
  -d '{"email":"alice@example.com","password":"correct-horse-battery-staple"}')
is "duplicate email rejected" "$(status "$R")" "409"

R=$(req -b "$TMP/a.cookies" -X POST "$BASE/api/entity/notes" -H 'content-type: application/json' \
  -d '{"title":"live","body":"real workers and d1"}')
N=$(body "$R")
has "authenticated create succeeds" "$N" '"title":"live"'
has "owner is auto-assigned" "$N" '"owner":"'
NOTE_ID=$(printf '%s' "$N" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')

has "owner sees own row"     "$(body "$(req -b "$TMP/a.cookies" "$BASE/api/entity/notes")")" '"total":1'
has "non-owner sees nothing" "$(body "$(req -b "$TMP/b.cookies" "$BASE/api/entity/notes")")" '"total":0'

is "anonymous create denied" "$(status "$(req -X POST "$BASE/api/entity/notes" -H 'content-type: application/json' -d '{"title":"x"}')")" "403"
is "non-owner read is 404"   "$(status "$(req -b "$TMP/b.cookies" "$BASE/api/entity/notes/$NOTE_ID")")" "404"
is "non-owner update is 404" "$(status "$(req -X PATCH -b "$TMP/b.cookies" -H 'content-type: application/json' -d '{"title":"pwned"}' "$BASE/api/entity/notes/$NOTE_ID")")" "404"
is "bad password rejected"   "$(status "$(req -X POST "$BASE/api/auth/login" -H 'content-type: application/json' -d '{"email":"alice@example.com","password":"wrong"}')")" "401"
is "good password logs in"   "$(status "$(req -X POST "$BASE/api/auth/login" -H 'content-type: application/json' -d '{"email":"alice@example.com","password":"correct-horse-battery-staple"}')")" "200"
is "owner delete succeeds"   "$(status "$(req -X DELETE -b "$TMP/a.cookies" "$BASE/api/entity/notes/$NOTE_ID")")" "204"

# --- Phase 4 -----------------------------------------------------------------
echo ""
echo "=== phase 4: persistence in real D1 ==="
ROWS=$("$W" d1 execute "$NAME-db" --remote --config "$CFG" -y --json \
  --command "SELECT (SELECT count(*) FROM users) u, (SELECT count(*) FROM notes) n, (SELECT substr(passwordHash,1,7) FROM users LIMIT 1) h" 2>/dev/null)
has "both users persisted in D1"   "$ROWS" '"u": 2'
has "delete persisted in D1"       "$ROWS" '"n": 0'
has "passwords are hashed at rest" "$ROWS" 'scrypt'

# --- Phase 5 -----------------------------------------------------------------
# The media plugin, backed by real R2. Reuses alice's authenticated cookie jar
# from phase 3 to upload a file, then proves the bytes round-trip, a guest
# cannot upload, and a second user cannot download someone else's file.
echo ""
echo "=== phase 5: media over real R2 ==="

MEDIA_FILE="$TMP/upload.txt"
printf 'frog bytes over r2' > "$MEDIA_FILE"

R=$(req -b "$TMP/a.cookies" -X POST "$BASE/api/media/upload" -F "file=@$MEDIA_FILE")
U=$(body "$R")
is "authenticated upload succeeds" "$(status "$R")" "200"
has "upload returns a key"         "$U" '"key":"'
KEY=$(printf '%s' "$U" | sed -n 's/.*"key":"\([^"]*\)".*/\1/p')

R=$(req -b "$TMP/a.cookies" "$BASE/files/$KEY")
is "owner downloads the file"   "$(status "$R")" "200"
is "downloaded bytes round-trip" "$(body "$R")" "frog bytes over r2"

is "guest upload denied"        "$(status "$(req -X POST "$BASE/api/media/upload" -F "file=@$MEDIA_FILE")")" "403"
is "cross-user download is 404" "$(status "$(req -b "$TMP/b.cookies" "$BASE/files/$KEY")")" "404"
