import { describe } from "vitest";
import { runAdapterConformance } from "frogcp/conformance";
import { libsqlAdapter } from "../../../src/adapter/libsql/index";

// Code-complete smoke test for the Turso (libsql://) remote path: the same
// shared conformance suite the local file::memory: adapter runs, pointed at a
// real Turso database. Exercising a live connection needs live credentials, so
// this is gated on TURSO_DATABASE_URL (with an optional TURSO_AUTH_TOKEN). When
// the env var is absent the skip is logged, so a test run never reports a quiet
// gap in coverage.
//
// To run it against a real database:
//   TURSO_DATABASE_URL="libsql://<db>-<org>.turso.io" TURSO_AUTH_TOKEN="<token>" pnpm test
const TURSO_URL = process.env.TURSO_DATABASE_URL;
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN;

if (!TURSO_URL) {
  console.log(
    "[adapter-libsql] Skipping Turso remote conformance suite: TURSO_DATABASE_URL is not set. " +
      "Set TURSO_DATABASE_URL (and optionally TURSO_AUTH_TOKEN) to a real Turso database to run it.",
  );
}

describe.skipIf(!TURSO_URL)("libsql adapter, Turso remote", () => {
  runAdapterConformance("libsql (Turso remote)", () =>
    libsqlAdapter(
      TURSO_AUTH_TOKEN !== undefined
        ? { url: TURSO_URL!, authToken: TURSO_AUTH_TOKEN }
        : { url: TURSO_URL! },
    ),
  );
});
