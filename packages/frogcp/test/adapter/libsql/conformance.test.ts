import { runAdapterConformance } from "frogcp/conformance";
import { libsqlAdapter } from "../../../src/adapter/libsql/index";

// The shared cross-adapter behavioral contract (fresh migrate, incremental
// migrate, atomic rollback, full CRUD via DataEngine, unique -> 409, FK ->
// 422/cascade), the same suite the node:sqlite adapter runs.
//
// Each it() calls makeAdapter() itself, so a fresh libsqlAdapter (and a fresh
// @libsql/client) is created per test. Plain file::memory: (no ?cache=shared)
// gives every client its own private, isolated in-memory database: two clients
// opened against file::memory: do not see each other's tables. That isolation,
// with the adapter using one client for both db and exec, is what makes
// :memory: safe here.
runAdapterConformance("libsql (file::memory:)", () => libsqlAdapter({ url: "file::memory:" }));
