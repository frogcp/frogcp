import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * migrate/sqlite.ts and migrate/postgres.ts must not statically import
 * drizzle-kit/api at module scope: it is a large Node-only bundle reached
 * transitively from kernel.ts (createBackend -> migrate/index.ts ->
 * migrate/sqlite.ts and migrate/postgres.ts), which broke bundling on Workers
 * and other non-Node runtimes.
 *
 * A lazy await import("drizzle-kit/api") fixed the runtime graph but not the
 * build: esbuild (and wrangler) constant-fold a string-literal import()
 * argument and eagerly resolve it, pulling in drizzle-kit's driver imports
 * (better-sqlite3, postgres, mysql2, ...) that a Workers app doesn't have, so
 * wrangler deploy failed even though the path is never executed. Routing the
 * specifier through a const defeats that static resolution.
 *
 * This is a source-level assertion. It greps the two migrate modules for
 * (a) no top-level value import from "drizzle-kit/api" (type-only is fine),
 * (b) no import() call passed the "drizzle-kit/api" string literal directly,
 * and (c) an await import(<identifier>) inside a function body where that
 * identifier is a module-scope const bound to the "drizzle-kit/api" string.
 * The real bundle-level check lives in examples/cloudflare.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrateDir = join(here, "..", "src", "migrate");

/** Top-level (module-scope) `import ... from "drizzle-kit/api"` that is not a
 * type-only import. A dynamic `await import(...)` inside a function body does
 * not match this. */
const STATIC_VALUE_IMPORT = /^import\s+(?!type\s)[^;]*from\s+["']drizzle-kit\/api["']/m;

/** Any `import(...)` call whose argument is the string literal
 * "drizzle-kit/api" (optionally wrapped in await), excluding a
 * `typeof import("drizzle-kit/api")` type query (erased at compile time). This
 * is the pattern that broke wrangler deploy. */
const LITERAL_DYNAMIC_IMPORT = /(?<!typeof\s)import\(\s*["']drizzle-kit\/api["']\s*\)/;

/** A lazy `await import(<bare identifier>)`: the specifier passed as an
 * identifier reference, not a literal, inside a function body. */
const LAZY_OPAQUE_IMPORT = /await\s+import\(\s*[A-Za-z_$][A-Za-z0-9_$]*\s*\)/;

/** A module-scope `const <IDENT> = "drizzle-kit/api";` binding. Captures the
 * identifier name so the test can cross-check it against LAZY_OPAQUE_IMPORT. */
const SPECIFIER_CONST = /^const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*["']drizzle-kit\/api["'];/m;

describe("migrate/{sqlite,postgres}.ts: drizzle-kit/api is imported lazily AND opaquely to bundlers, never at module scope", () => {
  it.each(["sqlite.ts", "postgres.ts"])("%s has no top-level VALUE import of drizzle-kit/api", (file) => {
    const source = readFileSync(join(migrateDir, file), "utf-8");
    expect(source).not.toMatch(STATIC_VALUE_IMPORT);
  });

  it.each(["sqlite.ts", "postgres.ts"])(
    "%s never passes the drizzle-kit/api STRING LITERAL directly to import() (the bundler-eager-resolution trap)",
    (file) => {
      const source = readFileSync(join(migrateDir, file), "utf-8");
      expect(source).not.toMatch(LITERAL_DYNAMIC_IMPORT);
    },
  );

  it.each(["sqlite.ts", "postgres.ts"])(
    "%s defines a module-scope drizzle-kit/api specifier constant, and lazily `await import`s it by identifier (opaque to esbuild)",
    (file) => {
      const source = readFileSync(join(migrateDir, file), "utf-8");
      const constMatch = source.match(SPECIFIER_CONST);
      expect(constMatch, "expected a `const X = \"drizzle-kit/api\";` binding at module scope").not.toBeNull();
      expect(source).toMatch(LAZY_OPAQUE_IMPORT);
      // Cross-check: the identifier actually await import()-ed is the same one
      // bound to the literal above, not two unrelated matches.
      const specifierName = constMatch![1];
      const importUsesSameIdentifier = new RegExp(`await\\s+import\\(\\s*${specifierName}\\s*\\)`).test(source);
      expect(importUsesSameIdentifier).toBe(true);
    },
  );

  it.each(["sqlite.ts", "postgres.ts"])("%s may still have a TYPE-only import of drizzle-kit/api at module scope", (file) => {
    const source = readFileSync(join(migrateDir, file), "utf-8");
    // Not required (a file could avoid it entirely); documents that the
    // type-only form is fine and is what's used here.
    expect(source.includes('import type') && source.includes('"drizzle-kit/api"')).toBe(true);
  });
});
