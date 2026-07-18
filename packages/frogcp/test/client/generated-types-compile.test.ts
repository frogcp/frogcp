import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { boolean, defineBackend, entity, ref, text, timestamp } from "frogcp";
import { generateTypes } from "frogcp/codegen";

const testDir = dirname(fileURLToPath(import.meta.url));
/** The real client source, so this checks generateTypes against the shipped
 * createClient rather than a stand-in for either side. */
const CLIENT_SRC_PATH = join(testDir, "..", "..", "src", "client", "client.ts");
/** Read from disk so the fixture compiles under the project's actual strictness
 * settings, and starts failing if those change. */
const TSCONFIG_BASE_PATH = join(testDir, "..", "..", "..", "..", "tsconfig.base.json");

const sampleConfig = defineBackend({
  entities: {
    notes: entity({
      title: text().required(),
      done: boolean().required().default(false),
      owner: ref("users").onDelete("cascade"),
      createdAt: timestamp().auto(),
    }),
    users: entity({
      email: text().required().unique(),
    }),
  },
});

/** Turns a path into a specifier TS accepts: forward slashes, extensionless,
 * and `./`-prefixed when `relative` does not already start with a dot. */
function toRelativeSpecifier(fromDir: string, toFile: string): string {
  const rel = relative(fromDir, toFile).replace(/\\/g, "/").replace(/\.ts$/, "");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

describe("generated client types", () => {
  it("compiles against createClient with zero diagnostics", () => {
    const output = generateTypes(sampleConfig);

    const dir = mkdtempSync(join(tmpdir(), "frogcp-client-typegen-"));
    const backendDtsPath = join(dir, "backend.d.ts");
    writeFileSync(backendDtsPath, output, "utf8");

    const clientSpecifier = toRelativeSpecifier(dir, CLIENT_SRC_PATH);
    const fixturePath = join(dir, "fixture.ts");
    const fixtureSrc = `
import type { ClientBackend } from "./backend";
import { createClient } from "${clientSpecifier}";

const client = createClient<ClientBackend>("http://example.com");

export async function run(): Promise<void> {
  const notes = client.entity("notes");
  const row = await notes.get("id-1");
  // The generated Row shape flows through entity(name).get(id).
  const title: string = row.title;
  const done: boolean = row.done;
  void title;
  void done;

  // A timestamp reads back as a string, never a Date: responses are plain
  // JSON and the client parses them without a reviver. \`createdAt\` is not
  // required, so the assertion strips the null and undefined.
  const createdAt: string = row.createdAt!;
  void createdAt;

  // "title" is the only mandatory key on the insert shape.
  const created = await notes.create({ title: "hello" });
  void created;

  const users = client.entity("users");
  const user = await users.get("id-2");
  const email: string = user.email;
  void email;
}
`;
    writeFileSync(fixturePath, fixtureSrc, "utf8");

    const configFile = ts.readConfigFile(TSCONFIG_BASE_PATH, ts.sys.readFile);
    expect(configFile.error, "expected tsconfig.base.json to parse cleanly").toBeUndefined();
    const parsed = ts.convertCompilerOptionsFromJson(configFile.config.compilerOptions, dirname(TSCONFIG_BASE_PATH));
    expect(parsed.errors, "expected tsconfig.base.json's compilerOptions to convert cleanly").toEqual([]);

    const program = ts.createProgram([fixturePath, backendDtsPath], { ...parsed.options, noEmit: true });

    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .filter((d) => d.file?.fileName === fixturePath || d.file?.fileName === backendDtsPath);

    const messages = diagnostics.map(
      (d) => `${d.file?.fileName}(${d.start ?? 0}): ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`,
    );
    expect(messages).toEqual([]);
  });
});
