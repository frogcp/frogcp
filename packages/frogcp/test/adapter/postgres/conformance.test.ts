import { describe, afterAll } from "vitest";
import { runAdapterConformance } from "frogcp/conformance";
import { postgresAdapter } from "../../../src/adapter/postgres/index";
import { startEphemeralPostgres } from "../../../src/adapter/postgres/testing/ephemeral-postgres";

// Runs the shared adapter conformance suite (the same one node:sqlite and
// libSQL run: migrate fresh, incremental migrate, atomic rollback, full CRUD
// through DataEngine, unique -> 409, FK -> 422/cascade) against a real,
// ephemeral, locally-started Postgres server (initdb + pg_ctl start into a temp
// data directory, torn down in afterAll).
//
// Started with a top-level await, not inside beforeAll, so the describe.skipIf
// below can see whether the server came up before vitest collects the suite.
// makeAdapter opens a fresh database per it() for isolation, since the suite's
// entity configs reuse table names across tests.
//
// If no full Postgres server install is found (or it fails to start),
// startEphemeralPostgres returns null with a logged reason and the whole suite
// is skipped rather than silently passed.
const ephemeral = await startEphemeralPostgres();

afterAll(async () => {
  await ephemeral?.stop();
});

describe.skipIf(ephemeral === null)("postgres adapter, live ephemeral server", () => {
  runAdapterConformance("postgres (ephemeral local server)", async () => {
    // Non-null: the describe.skipIf above only runs these when ephemeral !== null.
    const connectionString = await ephemeral!.createDatabase();
    return postgresAdapter({ connectionString });
  });
});
