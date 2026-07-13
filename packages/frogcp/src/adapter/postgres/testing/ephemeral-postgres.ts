/// <reference types="node" />
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "pg";

// Spins up a throwaway local Postgres server for tests. Lives under src/ (not
// test/) and is exported via the package's "./adapter/postgres/testing" subpath
// so other packages' suites can reuse it instead of each rolling their own
// server bootstrap.

const execFileP = promisify(execFile);

const STARTUP_TIMEOUT_MS = 20_000;

/**
 * Finds a directory with a full Postgres server install (postgres, initdb, and
 * pg_ctl together), not just libpq's client tools (Homebrew's standalone libpq
 * ships psql/pg_ctl/initdb but no postgres server binary). Checks, in order:
 *
 * 1. FROGCP_PG_BIN, for an explicit override.
 * 2. Homebrew's keg-only postgresql@18 down to @14, on both Apple Silicon
 *    (/opt/homebrew) and Intel (/usr/local) prefixes. Keg-only means these are
 *    never symlinked onto PATH.
 * 3. Debian/Ubuntu versioned installs (/usr/lib/postgresql/<ver>/bin), the
 *    layout most Postgres-in-CI containers use.
 * 4. Whatever is already on PATH.
 *
 * Returns null (never throws) when no candidate has all three binaries, so the
 * caller can skip the live suite rather than hang or fail opaquely.
 */
function findPgBinDir(): string | null {
  const candidates: string[] = [];
  if (process.env.FROGCP_PG_BIN) candidates.push(process.env.FROGCP_PG_BIN);
  for (const prefix of ["/opt/homebrew", "/usr/local"]) {
    for (const ver of ["18", "17", "16", "15", "14"]) {
      candidates.push(`${prefix}/opt/postgresql@${ver}/bin`);
    }
    candidates.push(`${prefix}/opt/postgresql/bin`);
  }
  for (const ver of ["18", "17", "16", "15", "14"]) {
    candidates.push(`/usr/lib/postgresql/${ver}/bin`);
  }

  for (const dir of candidates) {
    if (["postgres", "initdb", "pg_ctl"].every((bin) => existsSync(join(dir, bin)))) return dir;
  }

  // PATH-only fallback: existsSync can't resolve bare names, so shell out to
  // `command -v` for each required binary.
  try {
    for (const bin of ["postgres", "initdb", "pg_ctl"]) {
      execFileSync("command", ["-v", bin], { shell: "/bin/sh", stdio: "ignore" });
    }
    return "";
  } catch {
    return null;
  }
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close(() => {
        if (port) resolve(port);
        else reject(new Error("failed to allocate a free TCP port"));
      });
    });
  });
}

export interface EphemeralPostgres {
  /**
   * Opens a fresh, uniquely-named database on the server and returns its
   * connection string. The conformance suite calls makeAdapter once per it()
   * and needs full isolation between tests, since overlapping entity/table
   * names would otherwise collide in a shared database.
   */
  createDatabase: () => Promise<string>;
  /** Stops the server (pg_ctl ... stop -m fast) and removes its data directory. Idempotent. */
  stop: () => Promise<void>;
}

/**
 * Starts a throwaway local Postgres server for the conformance suite: initdb
 * into a fresh temp data directory, then pg_ctl start bound to TCP 127.0.0.1 on
 * a free port with Unix-socket listening disabled (unix_socket_directories='').
 * That sidesteps the 103-byte Unix socket path limit, which this repo's deeply
 * nested temp directories blow past; TCP loopback is just as fast for a test
 * run.
 *
 * Never throws and never hangs: any failure (binaries missing, initdb/pg_ctl
 * erroring, startup past STARTUP_TIMEOUT_MS) resolves to null with a logged
 * reason, so the caller can describe.skipIf honestly instead of hanging or
 * silently reporting green with no coverage.
 */
export async function startEphemeralPostgres(): Promise<EphemeralPostgres | null> {
  const binDir = findPgBinDir();
  if (binDir === null) {
    console.log(
      "[adapter-postgres] Skipping ephemeral-Postgres conformance: no full Postgres server install found " +
        "(checked FROGCP_PG_BIN, Homebrew postgresql@14..18 on /opt/homebrew and /usr/local, " +
        "/usr/lib/postgresql/14..18, and PATH). Install one, e.g. `brew install postgresql@18`, or set " +
        "FROGCP_PG_BIN to a directory containing `postgres`/`initdb`/`pg_ctl`, then re-run `pnpm test`.",
    );
    return null;
  }
  const bin = (name: string) => (binDir ? join(binDir, name) : name);

  const root = mkdtempSync(join(tmpdir(), "frogcp-pg-"));
  const dataDir = join(root, "data");
  const logFile = join(root, "server.log");

  const cleanupRoot = () => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best effort
    }
  };

  try {
    await execFileP(bin("initdb"), ["-D", dataDir, "--auth=trust", "-U", "postgres", "-E", "UTF8", "--no-sync"], {
      timeout: STARTUP_TIMEOUT_MS,
    });
  } catch (error) {
    console.log(`[adapter-postgres] Skipping ephemeral-Postgres conformance: initdb failed: ${String(error)}`);
    cleanupRoot();
    return null;
  }

  const port = await getFreePort().catch((error: unknown) => {
    console.log(`[adapter-postgres] Skipping ephemeral-Postgres conformance: could not allocate a port: ${String(error)}`);
    return null;
  });
  if (port === null) {
    cleanupRoot();
    return null;
  }

  try {
    await execFileP(
      bin("pg_ctl"),
      [
        "-D",
        dataDir,
        "-o",
        `-h 127.0.0.1 -p ${port} -c unix_socket_directories=''`,
        "-l",
        logFile,
        "-w",
        "-t",
        String(Math.ceil(STARTUP_TIMEOUT_MS / 1000)),
        "start",
      ],
      { timeout: STARTUP_TIMEOUT_MS },
    );
  } catch (error) {
    console.log(`[adapter-postgres] Skipping ephemeral-Postgres conformance: pg_ctl start failed: ${String(error)}`);
    cleanupRoot();
    return null;
  }

  const adminConnectionString = `postgresql://postgres@127.0.0.1:${port}/postgres`;

  // pg_ctl -w only waits for the PID file, not a working query, so probe with a
  // real connection before reporting ready.
  try {
    const probe = new Client({ connectionString: adminConnectionString, connectionTimeoutMillis: STARTUP_TIMEOUT_MS });
    await probe.connect();
    await probe.query("SELECT 1");
    await probe.end();
  } catch (error) {
    console.log(`[adapter-postgres] Skipping ephemeral-Postgres conformance: startup probe query failed: ${String(error)}`);
    await execFileP(bin("pg_ctl"), ["-D", dataDir, "-m", "fast", "stop"]).catch(() => {});
    cleanupRoot();
    return null;
  }

  let dbCounter = 0;
  const createDatabase = async (): Promise<string> => {
    const name = `frogcp_test_${process.pid}_${Date.now()}_${dbCounter++}`;
    const admin = new Client({ connectionString: adminConnectionString, connectionTimeoutMillis: STARTUP_TIMEOUT_MS });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${name}"`);
    } finally {
      await admin.end();
    }
    return `postgresql://postgres@127.0.0.1:${port}/${name}`;
  };

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    try {
      await execFileP(bin("pg_ctl"), ["-D", dataDir, "-m", "fast", "stop"], { timeout: STARTUP_TIMEOUT_MS });
    } catch (error) {
      // pg_ctl stop failed (e.g. timed out). Don't remove the data directory:
      // the postmaster may still be live and writing to it, so pulling it out
      // risks corrupting an unrelated cluster or orphaning processes. Leave it
      // (a small temp-dir leak the OS reclaims on reboot) and warn instead.
      console.warn(
        `[adapter-postgres] pg_ctl stop failed (${String(error)}); leaving data directory ${dataDir} in place ` +
          "rather than removing it from under a possibly-still-running postmaster.",
      );
      return;
    }
    cleanupRoot();
  };

  return { createDatabase, stop };
}
