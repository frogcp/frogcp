import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { and, count, eq, getTableColumns } from "drizzle-orm";
import type { Hono } from "hono";
import {
  ApiError,
  isUniqueViolation,
  type ApiVariables,
  type KernelContext,
  type Row,
  type SqliteDatabaseAdapter,
} from "frogcp";
import { hashPassword, verifyPassword } from "./password";
import { clearSessionCookie, issueSession, type SessionConfig } from "./session";

/**
 * Loose email-format check (`local@domain.tld` shape). This plugin has no `zod`
 * dependency, so this is a small hand-rolled equivalent rather than pulling one
 * in for a single check.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

/** Reset-token lifetime: 1 hour. Long enough to click a link just handed over, short enough that a leaked old link is dead. */
const RESET_TOKEN_TTL_SECONDS = 3600;
const RESET_TOKEN_PREFIX = "rst_";
/**
 * Longer passwords are rejected with the same 422 as the min-length check.
 * scrypt cost scales with input length, so an unbounded password is a cheap
 * pre-auth CPU-amplification vector against register. 256 is well above any real
 * password manager's output while bounding the work per request.
 */
const MAX_PASSWORD_LENGTH = 256;

/**
 * A stable, never-matching scrypt hash run through `verifyPassword` on an
 * unknown-email login, so the scrypt cost (and thus response timing) matches the
 * real-user path and login is not an email-enumeration oracle. Computed lazily
 * and cached, so the cost is paid once.
 */
let dummyHashPromise: Promise<string> | undefined;
function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword("frogcp-dummy-password-for-timing-flattening");
  return dummyHashPromise;
}

/**
 * Validates a to-be-set password (register, change, reset-confirm all apply the
 * same bounds; see `MAX_PASSWORD_LENGTH` for why an upper bound matters).
 */
function validateNewPassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new ApiError(422, "validation", `Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new ApiError(422, "validation", `Password must be at most ${MAX_PASSWORD_LENGTH} characters`);
  }
}

/** SHA-256 hex digest, how reset tokens are stored: the plaintext is shown once and only its hash persists. */
function sha256Hex(value: string): string {
  return bytesToHex(sha256(utf8ToBytes(value)));
}

/** Mints a one-time reset token: 32 random bytes, base64url, prefixed so a leaked string is recognizable as a frogCP reset token. */
function mintResetToken(): { resetToken: string; resetTokenHash: string; expiresAt: Date } {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let base64 = "";
  for (const b of bytes) base64 += String.fromCharCode(b);
  const resetToken = RESET_TOKEN_PREFIX + btoa(base64).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return {
    resetToken,
    resetTokenHash: sha256Hex(resetToken),
    expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_SECONDS * 1000),
  };
}

/** What a configured reset mailer receives (see `AuthRouteExtras.resetMailer`). */
export interface PasswordResetInfo {
  email: string;
  /** The one-time plaintext token; embed it in a `/reset?token=<...>` link. */
  resetToken: string;
  expiresAt: Date;
}

/** Delivers a reset token to the account holder (usually by email). */
export type PasswordResetMailer = (info: PasswordResetInfo) => Promise<void>;

export interface AuthRouteExtras {
  /**
   * When configured, `POST /api/auth/password-reset/request` mints and delivers
   * tokens; without it the endpoint still answers 202 but does nothing
   * (answering differently would advertise the mailer configuration).
   * Admin-issued links (`/password-reset/issue`) work either way.
   */
  resetMailer?: PasswordResetMailer;
}

/**
 * Reads and JSON-parses a request body, surfacing malformed JSON as a 422 and
 * normalizing anything that is not a JSON object to `{}` so callers can do plain
 * property lookups without further guards.
 */
async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  const raw = await req.text();
  if (raw.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ApiError(422, "validation", "Malformed JSON body");
  }
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
}

/**
 * Canonicalizes an email for storage and lookup (trimmed and lowercased). Both
 * register and login run raw input through this, so `Alice@Example.com` and
 * ` alice@example.com ` are the same account. Case-insensitive uniqueness is the
 * standard auth-system behavior even though RFC 5321 makes the local part
 * case-sensitive.
 */
export function normalizeEmail(raw: unknown): string {
  return (typeof raw === "string" ? raw : "").trim().toLowerCase();
}

/**
 * Strips a `users` row down to the wire-safe fields. `passwordHash` is
 * `.hidden()` so the engine would already strip it, but these routes bypass the
 * engine (direct `adapter.db` access), so this is the manual equivalent and also
 * guards against any unexpected column added later.
 *
 * Exported so `oauth.ts`'s `createOAuthUser` emits the same client-visible shape
 * on its own `record.created` event.
 */
export function publicUser(row: Row): Row {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    createdAt: row.createdAt,
  };
}

/** The `users` table, or a thrown error if the plugin's entities were not merged in. `authPlugin()` always contributes `users`, so this is a defensive invariant check. */
export function usersTableOrThrow(kernelCtx: KernelContext) {
  const table = kernelCtx.tables.users;
  if (!table) throw new Error('unreachable: authPlugin always registers a "users" table');
  return table;
}

/**
 * This plugin bypasses `DataEngine` and talks to `adapter.db` directly, and that
 * access is sqlite-shaped throughout. `KernelContext.adapter` is a
 * sqlite/postgres union, so every call site narrows through this helper, which
 * throws if wired to a non-sqlite adapter (postgres support is later work).
 */
export function sqliteDb(kernelCtx: KernelContext): SqliteDatabaseAdapter["db"] {
  if (kernelCtx.adapter.dialect !== "sqlite") {
    throw new Error(
      `frogcp/auth only supports the "sqlite" dialect today (got "${kernelCtx.adapter.dialect}")`,
    );
  }
  return kernelCtx.adapter.db;
}

/**
 * The role a brand-new `users` row gets: the first user this backend has ever
 * seen (across every creation path, register and OAuth alike, which all resolve
 * through this count) becomes `"admin"`, everyone after is `"member"`. Exported
 * so both creation paths apply the identical rule.
 *
 * Count-then-insert, not a transaction: two concurrent first-ever creations
 * could both observe `total === 0` and both become admin. Accepted race for v1.
 */
export async function bootstrapRole(
  kernelCtx: KernelContext,
  table: ReturnType<typeof usersTableOrThrow>,
): Promise<string> {
  const [countRow] = await sqliteDb(kernelCtx).select({ total: count() }).from(table);
  return (countRow?.total ?? 0) === 0 ? "admin" : "member";
}

/**
 * Registers `/api/auth/register`, `/login`, `/logout`, and `/me` on the kernel's
 * Hono app. Mounted directly, since the kernel hands plugins the full app and
 * mounts plugin routes before the core `/api/entity/*` wildcard.
 */
export function registerAuthRoutes(
  app: Hono<{ Variables: ApiVariables }>,
  kernelCtx: KernelContext,
  cfg: SessionConfig,
  extras: AuthRouteExtras = {},
): void {
  app.post("/api/auth/register", async (c) => {
    const body = await readJsonBody(c.req.raw);
    // Only email/password/name are read; any other key (`role`, `passwordHash`,
    // `id`) an attacker stuffs into the payload is silently ignored.
    const email = normalizeEmail(body.email);
    const password = typeof body.password === "string" ? body.password : "";
    const name = typeof body.name === "string" ? body.name : undefined;

    if (!EMAIL_RE.test(email)) {
      throw new ApiError(422, "validation", "Invalid email address");
    }
    validateNewPassword(password);

    const table = usersTableOrThrow(kernelCtx);

    // Duplicate emails are rejected by the insert itself: `email` is `.unique()`,
    // so the single insert below is the atomic duplicate check. There is no
    // pre-check SELECT, which would only narrow (never close) the race between
    // two concurrent registrations; the UNIQUE violation maps to a 409 below.

    // Bootstrap rule (see `bootstrapRole` for the accepted race): the first user
    // ever registered becomes "admin", everyone after "member", otherwise a
    // fresh backend could never reach admin-only actions.
    const role = await bootstrapRole(kernelCtx, table);

    const passwordHash = await hashPassword(password);
    const id = crypto.randomUUID();
    const createdAt = new Date();

    let inserted: Row | undefined;
    try {
      [inserted] = (await sqliteDb(kernelCtx)
        .insert(table)
        .values({ id, email, passwordHash, name: name ?? null, role, createdAt })
        .returning()) as Row[];
    } catch (error) {
      // The only UNIQUE constraint a fresh-uuid insert can trip is email's, so
      // the message names it outright (same wording as the core engine's 409).
      if (isUniqueViolation(error)) {
        throw new ApiError(409, "conflict", '"email" already exists');
      }
      throw error;
    }
    if (!inserted) throw new Error('insert into "users" returned no row');

    // Register bypasses `engine.create` (direct `adapter.db` access), so the
    // engine's own `record.created` never runs for this row; fire it manually
    // with the same hidden-stripped shape so plugins reacting to a new user see
    // every user, not just ones the entity engine inserted.
    await kernelCtx.events.emit("record.created", { entity: "users", row: publicUser(inserted), ctx: null });

    const { cookie } = await issueSession(cfg, id);
    c.header("Set-Cookie", cookie);
    return c.json({ data: { user: publicUser(inserted) } }, 201);
  });

  app.post("/api/auth/login", async (c) => {
    const body = await readJsonBody(c.req.raw);
    // Same canonical form register stored the email under; a casing or
    // whitespace mismatch must find the account, not 401.
    const email = normalizeEmail(body.email);
    const password = typeof body.password === "string" ? body.password : "";

    const table = usersTableOrThrow(kernelCtx);
    const columns = getTableColumns(table);
    const emailCol = columns.email;
    if (!emailCol) throw new Error('unreachable: users table always has an "email" column');

    // Not `engine.findByField`: that strips the `.hidden()` `passwordHash` before
    // this handler sees the row, but verifying a login is the one place that
    // needs it, and its `read` rule (`owner("id")`) could never be satisfied by
    // an unauthenticated attempt. This lookup is identity-free (its job is to
    // produce an identity) and reads the hidden column, so it stays a raw select.
    const rows = (await sqliteDb(kernelCtx).select().from(table).where(eq(emailCol, email)).limit(1)) as Row[];
    const user = rows[0];

    // Unknown email: verify against the dummy hash (never succeeds) so scrypt
    // cost and response timing match the real-user path, down to the same body.
    const storedHash = typeof user?.passwordHash === "string" ? user.passwordHash : await dummyHash();
    const valid = await verifyPassword(password, storedHash);

    if (!user || !valid) {
      throw new ApiError(401, "unauthorized", "invalid credentials");
    }

    const { cookie } = await issueSession(cfg, user.id as string);
    c.header("Set-Cookie", cookie);
    return c.json({ data: { user: publicUser(user) } }, 200);
  });

  app.post("/api/auth/logout", (c) => {
    // Sessionless logout is a no-op success: no caller-visible state to check
    // before clearing a cookie.
    c.header("Set-Cookie", clearSessionCookie(cfg));
    return c.json({ data: { ok: true } }, 200);
  });

  app.get("/api/auth/me", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) throw new ApiError(401, "unauthorized", "not authenticated");

    const table = usersTableOrThrow(kernelCtx);
    const columns = getTableColumns(table);
    const idCol = columns.id;
    if (!idCol) throw new Error('unreachable: users table always has an "id" column');

    const rows = (await sqliteDb(kernelCtx).select().from(table).where(eq(idCol, ctx.userId)).limit(1)) as Row[];
    const user = rows[0];
    // `identify` re-checks the row on every request, so this should never miss;
    // still, do not trust that invariant across a DB boundary without a fallback.
    if (!user) throw new ApiError(401, "unauthorized", "not authenticated");

    return c.json({ data: { user: publicUser(user) } }, 200);
  });

  /**
   * Changes the authenticated caller's password. Requires the current password
   * even with a valid session, so a hijacked session cannot lock the owner out.
   * Setting a new password also clears any outstanding reset token: both are
   * proofs of account control, and satisfying one invalidates the other.
   *
   * An account with no stored hash (OAuth-only) 409s: it has no current password
   * to prove; setting a first password for such accounts is a non-goal here.
   */
  app.post("/api/auth/password", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) throw new ApiError(401, "unauthorized", "not authenticated");

    const body = await readJsonBody(c.req.raw);
    const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
    const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
    validateNewPassword(newPassword);

    const table = usersTableOrThrow(kernelCtx);
    const columns = getTableColumns(table);
    const idCol = columns.id;
    if (!idCol) throw new Error('unreachable: users table always has an "id" column');

    const db = sqliteDb(kernelCtx);
    const rows = (await db.select().from(table).where(eq(idCol, ctx.userId)).limit(1)) as Row[];
    const user = rows[0];
    if (!user) throw new ApiError(401, "unauthorized", "not authenticated");

    const storedHash = typeof user.passwordHash === "string" ? user.passwordHash : null;
    if (!storedHash) throw new ApiError(409, "conflict", "no password is set on this account");

    // Over-long current password: reject as invalid credentials without running
    // scrypt over it (same bound register applies via MAX_PASSWORD_LENGTH; a
    // legitimate stored password can never exceed it).
    const valid = currentPassword.length <= MAX_PASSWORD_LENGTH && (await verifyPassword(currentPassword, storedHash));
    if (!valid) throw new ApiError(401, "unauthorized", "invalid credentials");

    const passwordHash = await hashPassword(newPassword);
    await db
      .update(table)
      .set({ passwordHash, resetTokenHash: null, resetTokenExpiresAt: null })
      .where(eq(idCol, ctx.userId));

    return c.json({ data: { ok: true } }, 200);
  });

  /**
   * Self-serve reset request. Always answers 202 with the same body, whether the
   * email exists, is malformed, or no mailer is configured, so it is not an
   * account-enumeration oracle. A token is minted and delivered only when both a
   * matching user and a configured `resetMailer` exist; mailer failures are
   * logged and swallowed for the same no-oracle reason.
   *
   * Accepted timing caveat: with a mailer configured, the existing-email path
   * does more work than the unknown-email path, so timing is not flat the way
   * login's is. Flattening means out-of-band delivery, deferred until a real
   * mailer integration exists.
   */
  app.post("/api/auth/password-reset/request", async (c) => {
    const body = await readJsonBody(c.req.raw);
    const email = normalizeEmail(body.email);
    const accepted = () => c.json({ data: { ok: true } }, 202);

    const mailer = extras.resetMailer;
    if (!mailer || !EMAIL_RE.test(email)) return accepted();

    const table = usersTableOrThrow(kernelCtx);
    const columns = getTableColumns(table);
    const emailCol = columns.email;
    const idCol = columns.id;
    if (!emailCol || !idCol) throw new Error('unreachable: users table always has "email"/"id" columns');

    const db = sqliteDb(kernelCtx);
    const rows = (await db.select().from(table).where(eq(emailCol, email)).limit(1)) as Row[];
    const user = rows[0];
    if (!user) return accepted();

    const { resetToken, resetTokenHash, expiresAt } = mintResetToken();
    await db.update(table).set({ resetTokenHash, resetTokenExpiresAt: expiresAt }).where(eq(idCol, user.id as string));
    try {
      await mailer({ email, resetToken, expiresAt });
    } catch (error) {
      console.error("frogcp/auth: password-reset mailer failed", error);
    }
    return accepted();
  });

  /**
   * Admin-issued reset link, the delivery path that needs no email infra: an
   * admin generates a one-time token and hands it over out of band. The plaintext
   * appears once, in this response; only its hash is stored. Admin-only because
   * issuing yourself a token for any email is account takeover by construction.
   */
  app.post("/api/auth/password-reset/issue", async (c) => {
    const ctx = c.get("ctx");
    if (!ctx) throw new ApiError(401, "unauthorized", "not authenticated");
    if (ctx.role !== "admin") throw new ApiError(403, "forbidden", "admin only");

    const body = await readJsonBody(c.req.raw);
    const email = normalizeEmail(body.email);
    if (!EMAIL_RE.test(email)) throw new ApiError(422, "validation", "Invalid email address");

    const table = usersTableOrThrow(kernelCtx);
    const columns = getTableColumns(table);
    const emailCol = columns.email;
    const idCol = columns.id;
    if (!emailCol || !idCol) throw new Error('unreachable: users table always has "email"/"id" columns');

    const db = sqliteDb(kernelCtx);
    const rows = (await db.select().from(table).where(eq(emailCol, email)).limit(1)) as Row[];
    const user = rows[0];
    // A plain 404 is fine here (unlike request's no-oracle 202): the caller is
    // an authenticated admin, who can list users anyway.
    if (!user) throw new ApiError(404, "not_found", "no account with that email");

    const { resetToken, resetTokenHash, expiresAt } = mintResetToken();
    await db.update(table).set({ resetTokenHash, resetTokenExpiresAt: expiresAt }).where(eq(idCol, user.id as string));

    return c.json({ data: { resetToken, expiresAt: expiresAt.toISOString() } }, 200);
  });

  /**
   * Consumes a reset token and sets the new password. Unknown, expired, and
   * already-used tokens are indistinguishable (all 404). Single-use is enforced
   * by the conditional UPDATE (`WHERE id = ? AND resetTokenHash = ?`): two racing
   * confirms can both pass the SELECT, but exactly one UPDATE matches the
   * still-present hash and wins; the loser affects 0 rows and 404s. Success does
   * not issue a session; the caller proves control by logging in with the new
   * password.
   */
  app.post("/api/auth/password-reset/confirm", async (c) => {
    const body = await readJsonBody(c.req.raw);
    const token = typeof body.token === "string" ? body.token : "";
    const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
    validateNewPassword(newPassword);

    const notFound = () => new ApiError(404, "not_found", "invalid or expired reset token");
    // Length bound: sha256 over megabytes of client input is a mild CPU vector on
    // an unauthenticated route; real tokens are ~47 chars.
    if (!token || token.length > 256) throw notFound();

    const table = usersTableOrThrow(kernelCtx);
    const columns = getTableColumns(table);
    const idCol = columns.id;
    const resetTokenHashCol = columns.resetTokenHash;
    if (!idCol || !resetTokenHashCol) {
      throw new Error('unreachable: users table always has "id"/"resetTokenHash" columns');
    }

    const tokenHash = sha256Hex(token);
    const db = sqliteDb(kernelCtx);
    const rows = (await db.select().from(table).where(eq(resetTokenHashCol, tokenHash)).limit(1)) as Row[];
    const user = rows[0];
    if (!user) throw notFound();

    // Expiry: `timestamp` fields come back as `Date` on sqlite, but stay
    // defensive about the driver representation (integer ms or ISO string).
    const rawExpiry = user.resetTokenExpiresAt;
    const expiresAtMs =
      rawExpiry instanceof Date
        ? rawExpiry.getTime()
        : typeof rawExpiry === "number" || typeof rawExpiry === "string"
          ? new Date(rawExpiry).getTime()
          : Number.NaN;
    if (!Number.isFinite(expiresAtMs) || expiresAtMs < Date.now()) throw notFound();

    const passwordHash = await hashPassword(newPassword);
    const [updated] = (await db
      .update(table)
      .set({ passwordHash, resetTokenHash: null, resetTokenExpiresAt: null })
      .where(and(eq(idCol, user.id as string), eq(resetTokenHashCol, tokenHash)))
      .returning()) as Row[];
    if (!updated) throw notFound();

    return c.json({ data: { ok: true } }, 200);
  });
}
