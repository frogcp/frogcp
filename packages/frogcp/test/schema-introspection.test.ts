import { describe, it, expect } from "vitest";
import { nodeSqliteAdapter } from "./support/node-sqlite-adapter";
import {
  createBackend,
  defineBackend,
  entity,
  text,
  boolean,
  select,
  ref,
  rule,
  role,
  type DatabaseAdapter,
  type Backend,
} from "../src/index";

// A sample config exercising every field/rule flag the rich schema endpoint
// needs to surface: a hidden field, a readonly field, a select field, a ref
// field, and an owner()-OR-role() permission rule.
const config = defineBackend({
  entities: {
    users: entity({
      name: text().required(),
    }).permissions({
      read: rule.owner("id"),
    }),
    notes: entity({
      title: text().required(),
      secret: text().hidden(),
      status: select(["draft", "published"]).default("draft"),
      owner: ref("users"),
      pinned: boolean().readonly(),
    }).permissions({
      create: rule.authenticated(),
      list: rule.owner("owner"),
      read: rule.owner("owner").or(role("admin")),
    }),
  },
});

const BASE = "http://x";
const ADMIN = "admin-seed:admin";
const MEMBER = "member-seed:member";

function req(path: string, identity?: string): Request {
  const h = new Headers();
  if (identity) h.set("x-frogcp-debug-identity", identity);
  return new Request(`${BASE}${path}`, { headers: h });
}

async function setup(): Promise<{ backend: Backend }> {
  const adapter: DatabaseAdapter = nodeSqliteAdapter(":memory:");
  const backend = await createBackend({ config, adapter, debugIdentity: true });
  return { backend };
}

interface FieldSummary {
  type: string;
  required: boolean;
  default?: unknown;
  auto?: boolean;
  options?: readonly string[];
  target?: string;
  unique?: boolean;
  hidden?: boolean;
  readonly?: boolean;
}

interface SchemaResponse {
  data: {
    entities: Record<
      string,
      { fields: Record<string, FieldSummary>; permissions: Record<string, string> }
    >;
  };
}

describe("GET /api/system/schema (rich introspection)", () => {
  it("guest gets 403", async () => {
    const { backend } = await setup();
    const res = await backend.fetch(req("/api/system/schema"));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
  });

  it("member gets 403", async () => {
    const { backend } = await setup();
    const res = await backend.fetch(req("/api/system/schema", MEMBER));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
  });

  it("admin gets full per-field metadata and rule summaries", async () => {
    const { backend } = await setup();
    const res = await backend.fetch(req("/api/system/schema", ADMIN));
    expect(res.status).toBe(200);
    const body = (await res.json()) as SchemaResponse;

    const notes = body.data.entities.notes;
    expect(notes).toBeDefined();
    const fields = notes!.fields;

    // Plain required field: only type + required set.
    expect(fields.title).toEqual({ type: "text", required: true });

    // Hidden field: included (not stripped, this endpoint is admin-only) and
    // flagged hidden:true.
    expect(fields.secret).toEqual({ type: "text", required: false, hidden: true });

    // Select field: options + default surfaced.
    expect(fields.status).toEqual({
      type: "select",
      required: false,
      options: ["draft", "published"],
      default: "draft",
    });

    // Ref field: target entity surfaced.
    expect(fields.owner).toEqual({ type: "ref", required: false, target: "users" });

    // Readonly field: flagged readonly:true.
    expect(fields.pinned).toEqual({ type: "boolean", required: false, readonly: true });

    const permissions = notes!.permissions;
    expect(permissions.create).toBe("authenticated");
    expect(permissions.list).toBe("owner(owner)");
    expect(permissions.read).toBe("owner(owner) OR role(admin)");
    // No rule declared for update/delete -> omitted entirely (default-deny,
    // admin-only), not present with any placeholder value.
    expect(permissions.update).toBeUndefined();
    expect(permissions.delete).toBeUndefined();
  });
});
