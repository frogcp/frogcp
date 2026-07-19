import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect, vi } from "vitest";
import { schemaCommand } from "../../src/cli/commands/schema";
import { CliError } from "../../src/cli/errors";
import { main } from "../../src/cli/index";

const PLAIN_CONFIG = `import { defineBackend, entity, boolean, text, timestamp } from "frogcp";

export default defineBackend({
  entities: {
    notes: entity({
      title: text().required(),
      done: boolean().default(false),
      createdAt: timestamp().auto(),
    }),
  },
});
`;

/**
 * The shape the control plane deploys: an App descriptor whose plugins
 * contribute entities the config itself never declares, with a config entity
 * holding a foreign key into one of them (`notes.owner` -> auth's `users`).
 */
const APP_WITH_AUTH = `import { defineApp, defineBackend, entity, ref, text, timestamp } from "frogcp";
import { authPlugin } from "frogcp/auth";

export default defineApp({
  config: defineBackend({
    entities: {
      notes: entity({
        title: text().required(),
        owner: ref("users").onDelete("cascade"),
        createdAt: timestamp().auto(),
      }),
    },
  }),
  plugins: [authPlugin({ secret: "test-secret-long-enough-for-authplugin" })],
});
`;

/**
 * The shape a Workers app has to use: the plugin list is a function of the
 * runtime and the auth secret is lazy, because on Workers `env` only exists per
 * request. `frogcp schema` must produce the full DDL from it without a secret in
 * the environment at all.
 */
const APP_WITH_LAZY_AUTH_SECRET = `import { defineApp, defineBackend, entity, ref, text } from "frogcp";
import { authPlugin } from "frogcp/auth";

export default defineApp({
  config: defineBackend({
    entities: {
      notes: entity({
        title: text().required(),
        owner: ref("users").onDelete("cascade"),
      }),
    },
  }),
  plugins: (ctx) => [
    authPlugin({
      secret: () => {
        const secret = ctx.env.AUTH_SECRET;
        if (typeof secret !== "string") throw new Error("AUTH_SECRET is not set");
        return secret;
      },
    }),
  ],
});
`;

function writeConfig(source: string, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const configPath = join(dir, "frogcp.config.ts");
  writeFileSync(configPath, source, "utf8");
  return configPath;
}

/** Applies `sql` to a fresh in-memory database and returns it, so a test can assert on the real schema. */
function applyToFreshDatabase(sql: string): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(sql);
  return db;
}

function tableNames(db: DatabaseSync): string[] {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
  return rows.map((row) => row.name);
}

describe("schemaCommand", () => {
  it("prints the full CREATE DDL for a fresh database, one semicolon-terminated statement per line", async () => {
    const configPath = writeConfig(PLAIN_CONFIG, "frogcp-cli-schema-");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await schemaCommand({ config: configPath });

      expect(result.dialect).toBe("sqlite");
      expect(result.sql).toMatch(/CREATE TABLE/i);
      expect(result.sql).toMatch(/notes/i);
      for (const statement of result.statements) {
        expect(statement.trimEnd().endsWith(";")).toBe(true);
      }
      // Only the SQL reaches stdout, so `frogcp schema > schema.sql` pipes cleanly.
      expect(log.mock.calls).toEqual([[result.sql]]);
    } finally {
      log.mockRestore();
    }
  });

  it("includes plugin-contributed entities and applies to a fresh database in one shot", async () => {
    const configPath = writeConfig(APP_WITH_AUTH, "frogcp-cli-schema-auth-");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let db: DatabaseSync | undefined;
    try {
      const { sql } = await schemaCommand({ config: configPath });

      db = applyToFreshDatabase(sql);
      expect(tableNames(db)).toEqual(expect.arrayContaining(["notes", "users", "oauthAccounts"]));

      const foreignKeys = db.prepare("SELECT \"table\", \"from\" FROM pragma_foreign_key_list('notes')").all() as {
        table: string;
        from: string;
      }[];
      expect(foreignKeys).toEqual(expect.arrayContaining([expect.objectContaining({ table: "users", from: "owner" })]));
    } finally {
      db?.close();
      log.mockRestore();
    }
  });

  it("compiles an app whose plugins are runtime-resolved and whose auth secret is lazy, with no secret set", async () => {
    const configPath = writeConfig(APP_WITH_LAZY_AUTH_SECRET, "frogcp-cli-schema-lazy-");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const previous = process.env.AUTH_SECRET;
    delete process.env.AUTH_SECRET;
    let db: DatabaseSync | undefined;
    try {
      const { sql } = await schemaCommand({ config: configPath });

      db = applyToFreshDatabase(sql);
      expect(tableNames(db)).toEqual(expect.arrayContaining(["notes", "users", "oauthAccounts"]));
    } finally {
      db?.close();
      if (previous !== undefined) process.env.AUTH_SECRET = previous;
      log.mockRestore();
    }
  });

  it("omits the __frogcp_migrations bookkeeping table", async () => {
    const configPath = writeConfig(PLAIN_CONFIG, "frogcp-cli-schema-bookkeeping-");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { sql } = await schemaCommand({ config: configPath });
      expect(sql).not.toContain("__frogcp_migrations");
    } finally {
      log.mockRestore();
    }
  });

  it("emits postgres DDL with --dialect postgres", async () => {
    const configPath = writeConfig(PLAIN_CONFIG, "frogcp-cli-schema-pg-");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await schemaCommand({ config: configPath, dialect: "postgres" });
      expect(result.dialect).toBe("postgres");
      expect(result.sql).toMatch(/CREATE TABLE/i);
      // The sqlite compile path has no `text`/`integer` distinction Postgres uses.
      expect(result.sql).toMatch(/"notes"/);
    } finally {
      log.mockRestore();
    }
  });

  it("points a bare config with a dangling ref at defineApp, since a plugin most likely owns the target", async () => {
    // The exact shape of the cloudflare example: `ref("users")` resolves at boot
    // because authPlugin contributes `users`, but a config-only export has no
    // way to tell the CLI that.
    const configPath = writeConfig(
      `import { defineBackend, entity, ref, text } from "frogcp";

export default defineBackend({
  entities: {
    notes: entity({ title: text().required(), owner: ref("users") }),
  },
});
`,
      "frogcp-cli-schema-dangling-",
    );
    await expect(schemaCommand({ config: configPath })).rejects.toThrow(/defineApp/);
  });

  it("fails with a clear CliError when the config's default export is neither a config nor an app", async () => {
    const configPath = writeConfig("export default 42;\n", "frogcp-cli-schema-bad-");
    await expect(schemaCommand({ config: configPath })).rejects.toThrow(CliError);
  });
});

describe("frogcp schema (entrypoint)", () => {
  it("writes the DDL to stdout and exits 0", async () => {
    const configPath = writeConfig(PLAIN_CONFIG, "frogcp-cli-schema-main-");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = await main(["schema", "--config", configPath]);
      expect(code).toBe(0);
      expect(log.mock.calls.flat().join("\n")).toMatch(/CREATE TABLE/i);
    } finally {
      log.mockRestore();
    }
  });

  it("rejects an unknown --dialect instead of silently falling back to sqlite", async () => {
    const configPath = writeConfig(PLAIN_CONFIG, "frogcp-cli-schema-dialect-");
    const errors: string[] = [];
    const error = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = await main(["schema", "--config", configPath, "--dialect", "mysql"]);
      expect(code).toBe(1);
      expect(errors.join("\n")).toMatch(/Unknown dialect "mysql"/);
      expect(log).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
      log.mockRestore();
    }
  });
});
