import { describe, it, expect } from "vitest";
import { nodeSqliteAdapter, memoryStorage } from "frogcp/adapter/node";
import {
  createBackend,
  defineBackend,
  entity,
  text,
  media,
  rule,
  migrateToConfig,
  compileTables,
  DataEngine,
  EventBus,
  type DatabaseAdapter,
  type FrogPlugin,
  type KernelContext,
  type StorageAdapter,
} from "../src/index";

function makeAdapter(): DatabaseAdapter {
  return nodeSqliteAdapter(":memory:");
}

const publicPerms = {
  create: rule.public(),
  read: rule.public(),
  list: rule.public(),
  update: rule.public(),
  delete: rule.public(),
};

describe("media() field contract", () => {
  // media() stores a storage-key string, not bytes: it compiles to a plain
  // text column (see compile.test.ts for the column-type assertions) with no
  // special engine handling. This confirms the DataEngine round-trips an
  // arbitrary key string through create/read with no accidental special-casing.
  const config = defineBackend({
    entities: {
      photos: entity({
        caption: text(),
        cover: media(),
      }).permissions(publicPerms),
    },
  });

  async function setup() {
    const adapter = nodeSqliteAdapter(":memory:");
    await migrateToConfig(adapter, config);
    const tables = compileTables(config);
    const engine = new DataEngine(adapter, config, tables, new EventBus());
    return { engine };
  }

  it("round-trips a storage-key string through create/read unchanged", async () => {
    const { engine } = await setup();

    const created = await engine.create(
      "photos",
      { caption: "a frog", cover: "uploads/abc123.png" },
      null,
    );
    expect(created.cover).toBe("uploads/abc123.png");

    const read = await engine.read("photos", created.id as string, null);
    expect(read.cover).toBe("uploads/abc123.png");
  });

  it("accepts any string value (no special validation/format beyond text)", async () => {
    const { engine } = await setup();

    const created = await engine.create("photos", { cover: "just-a-plain-key" }, null);
    expect(created.cover).toBe("just-a-plain-key");
  });
});

describe("KernelContext.storage wiring", () => {
  const config = defineBackend({
    entities: {
      notes: entity({ title: text().required() }).permissions(publicPerms),
    },
  });

  it("populates ctx.storage from opts.storage: a plugin's onBoot sees the exact same adapter instance", async () => {
    const storage = memoryStorage();
    let observed: StorageAdapter | undefined;

    const probe: FrogPlugin = {
      name: "probe",
      onBoot(ctx: KernelContext) {
        observed = ctx.storage;
      },
    };

    await createBackend({ config, adapter: makeAdapter(), storage, plugins: [probe] });

    expect(observed).toBe(storage);
  });

  it("leaves ctx.storage undefined when opts.storage is not provided", async () => {
    let observed: StorageAdapter | undefined = memoryStorage(); // seed with a truthy value to prove it gets overwritten

    const probe: FrogPlugin = {
      name: "probe",
      onBoot(ctx: KernelContext) {
        observed = ctx.storage;
      },
    };

    await createBackend({ config, adapter: makeAdapter(), plugins: [probe] });

    expect(observed).toBeUndefined();
  });

  it("a storage adapter wired in is actually usable (put/get round-trip) from within onBoot", async () => {
    const storage = memoryStorage();
    let roundTripped: Uint8Array | null = null;

    const probe: FrogPlugin = {
      name: "probe",
      async onBoot(ctx: KernelContext) {
        await ctx.storage?.put("k", new Uint8Array([1, 2, 3]));
        roundTripped = (await ctx.storage?.get("k")) ?? null;
      },
    };

    await createBackend({ config, adapter: makeAdapter(), storage, plugins: [probe] });

    expect(roundTripped).toEqual(new Uint8Array([1, 2, 3]));
  });
});
