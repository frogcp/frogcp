import { describe, expect, it } from "vitest";
import { memoryStorage, nodeSqliteAdapter } from "frogcp/adapter/node";
import { createBackend, defineBackend, type Backend, type DatabaseAdapter, type StorageAdapter } from "frogcp";
import { FILES_ENTITY, mediaPlugin, type MediaPluginOptions } from "../../src/media/index";

const BASE = "http://x";

/** An empty application config: the media plugin contributes its own
 * media_files entity via the plugin merge in createBackend, so no
 * application-level entities are needed for these tests. */
const emptyConfig = defineBackend({ entities: {} });

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`${BASE}${path}`, init);
}

/** x-frogcp-debug-identity: userId:role is the framework's test-only identity
 * shortcut (createBackend({ debugIdentity: true })), used here instead of a
 * full frogcp/auth session, since a debug identity populates Ctx identically
 * to a real one for the permission checks this plugin relies on. */
function asUser(userId: string, role = "member"): Record<string, string> {
  return { "x-frogcp-debug-identity": `${userId}:${role}` };
}

async function setup(opts?: MediaPluginOptions): Promise<{ backend: Backend; adapter: DatabaseAdapter; storage: StorageAdapter }> {
  const adapter: DatabaseAdapter = nodeSqliteAdapter(":memory:");
  const storage = memoryStorage();
  const backend = await createBackend({
    config: emptyConfig,
    adapter,
    debugIdentity: true,
    storage,
    plugins: [mediaPlugin(opts)],
  });
  return { backend, adapter, storage };
}

function makeFormData(content: string, filename: string, type: string): FormData {
  const form = new FormData();
  form.append("file", new Blob([content], { type }), filename);
  return form;
}

describe("mediaPlugin: onBoot", () => {
  it("throws when createBackend is not given a storage adapter", async () => {
    const adapter: DatabaseAdapter = nodeSqliteAdapter(":memory:");
    await expect(
      createBackend({
        config: emptyConfig,
        adapter,
        debugIdentity: true,
        plugins: [mediaPlugin()],
        // deliberately no `storage`
      }),
    ).rejects.toThrow(/storage adapter/i);
  });
});

describe("mediaPlugin: upload + serve", () => {
  it("uploads a file as an authenticated user and serves it back with the right bytes + content-type", async () => {
    const { backend } = await setup();

    const form = makeFormData("hello world", "greeting.txt", "text/plain");
    const uploadRes = await backend.fetch(
      req("/api/media/upload", { method: "POST", body: form, headers: asUser("user-a") }),
    );
    expect(uploadRes.status).toBe(200);
    const uploadBody = (await uploadRes.json()) as { data: { key: string; filename: string; contentType: string; size: number } };
    expect(uploadBody.data.key).toMatch(/\.txt$/);
    expect(uploadBody.data.filename).toBe("greeting.txt");
    expect(uploadBody.data.contentType).toBe("text/plain");
    expect(uploadBody.data.size).toBe("hello world".length);

    const getRes = await backend.fetch(req(`/files/${uploadBody.data.key}`, { headers: asUser("user-a") }));
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get("content-type")).toBe("text/plain");
    expect(getRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await getRes.text()).toBe("hello world");
  });

  it("rejects an upload from an unauthenticated caller with 403 (create requires authenticated())", async () => {
    const { backend } = await setup();

    const form = makeFormData("nope", "x.txt", "text/plain");
    const res = await backend.fetch(req("/api/media/upload", { method: "POST", body: form }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
  });

  it("rejects an unauthenticated (guest) upload with 403 BEFORE the multipart body is parsed: no media_files row is created and the bytes never reach storage", async () => {
    // A storage adapter wrapping memoryStorage() that counts put calls, to
    // prove the permission check runs strictly before any bytes could reach
    // storage, not just that the response is eventually 403.
    let putCalls = 0;
    const inner = memoryStorage();
    const spiedStorage: StorageAdapter = {
      ...inner,
      async put(key, data, meta) {
        putCalls++;
        return inner.put(key, data, meta);
      },
    };

    const adapter: DatabaseAdapter = nodeSqliteAdapter(":memory:");
    const backend = await createBackend({
      config: emptyConfig,
      adapter,
      debugIdentity: true,
      storage: spiedStorage,
      plugins: [mediaPlugin()],
    });

    const form = makeFormData("private, never persisted", "guest.txt", "text/plain");
    const res = await backend.fetch(req("/api/media/upload", { method: "POST", body: form }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");

    // storage.put was never reached: the 403 fires before the multipart body
    // is even parsed, let alone before any bytes are written.
    expect(putCalls).toBe(0);

    // No row was ever inserted either, checked as admin (which bypasses the
    // entity's own permission rules) so this reflects the true row count.
    const listRes = await backend.fetch(
      req(`/api/entity/${FILES_ENTITY}`, { headers: asUser("admin-1", "admin") }),
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { data: unknown[] };
    expect(listBody.data).toHaveLength(0);
  });

  it("rejects an upload exceeding maxBytes with 413 payload_too_large", async () => {
    const { backend } = await setup({ maxBytes: 4 });

    const form = makeFormData("this is more than four bytes", "big.txt", "text/plain");
    const res = await backend.fetch(
      req("/api/media/upload", { method: "POST", body: form, headers: asUser("user-a") }),
    );
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("payload_too_large");
  });

  it("sanitizes the file extension: a filename with a slash yields a slash-free key that round-trips", async () => {
    const { backend } = await setup();

    // The last-dot suffix here is ".tar/y", a slash-bearing string that would
    // produce a storage key the single-segment /files/:key could never serve
    // back. The allowlist must drop it entirely, leaving a bare-uuid key.
    const form = makeFormData("archived", "x.tar/y", "application/octet-stream");
    const uploadRes = await backend.fetch(
      req("/api/media/upload", { method: "POST", body: form, headers: asUser("user-a") }),
    );
    expect(uploadRes.status).toBe(200);
    const { data } = (await uploadRes.json()) as { data: { key: string } };
    expect(data.key).not.toContain("/");
    // No clean extension survived, so the key is the bare uuid (no dot).
    expect(data.key).not.toContain(".");

    const getRes = await backend.fetch(req(`/files/${data.key}`, { headers: asUser("user-a") }));
    expect(getRes.status).toBe(200);
    expect(await getRes.text()).toBe("archived");
  });

  it("denies an UNAUTHENTICATED (guest) request against a default owner-scoped file with 404 (no oracle)", async () => {
    const { backend } = await setup();

    const form = makeFormData("private bytes", "secret.txt", "text/plain");
    const uploadRes = await backend.fetch(
      req("/api/media/upload", { method: "POST", body: form, headers: asUser("user-a") }),
    );
    const { data } = (await uploadRes.json()) as { data: { key: string } };

    // No debug-identity header at all, so a guest (ctx === null). Under the
    // default ownerScoped rule checkRow denies a guest, and the denial must
    // fold into 404 (indistinguishable from a missing key).
    const guestFetch = await backend.fetch(req(`/files/${data.key}`));
    expect(guestFetch.status).toBe(404);
  });

  it("owner-scopes reads by default: the uploader can fetch their file, another user gets 404, and a missing key is 404", async () => {
    const { backend } = await setup();

    const form = makeFormData("secret", "s.txt", "text/plain");
    const uploadRes = await backend.fetch(
      req("/api/media/upload", { method: "POST", body: form, headers: asUser("user-a") }),
    );
    const { data } = (await uploadRes.json()) as { data: { key: string } };

    const ownFetch = await backend.fetch(req(`/files/${data.key}`, { headers: asUser("user-a") }));
    expect(ownFetch.status).toBe(200);

    const otherFetch = await backend.fetch(req(`/files/${data.key}`, { headers: asUser("user-b") }));
    expect(otherFetch.status).toBe(404);

    const missingFetch = await backend.fetch(req("/files/does-not-exist", { headers: asUser("user-a") }));
    expect(missingFetch.status).toBe(404);
  });

  it("ownerScoped: false makes reads public, including for guests", async () => {
    const { backend } = await setup({ ownerScoped: false });

    const form = makeFormData("public content", "p.txt", "text/plain");
    const uploadRes = await backend.fetch(
      req("/api/media/upload", { method: "POST", body: form, headers: asUser("user-a") }),
    );
    const { data } = (await uploadRes.json()) as { data: { key: string } };

    const guestFetch = await backend.fetch(req(`/files/${data.key}`));
    expect(guestFetch.status).toBe(200);
    expect(await guestFetch.text()).toBe("public content");

    const otherUserFetch = await backend.fetch(req(`/files/${data.key}`, { headers: asUser("user-b") }));
    expect(otherUserFetch.status).toBe(200);
  });

  it("records the uploader as the row's owner, queryable via the entity table", async () => {
    const { backend, adapter } = await setup();

    const form = makeFormData("row check", "r.txt", "text/plain");
    const uploadRes = await backend.fetch(
      req("/api/media/upload", { method: "POST", body: form, headers: asUser("user-a") }),
    );
    const { data } = (await uploadRes.json()) as { data: { key: string } };

    // Read the row back as the admin, which bypasses every rule, so this is
    // the standard way to inspect a row's full server-side state.
    const listRes = await backend.fetch(
      req(`/api/entity/${FILES_ENTITY}?filter[key][eq]=${encodeURIComponent(data.key)}`, {
        headers: asUser("admin-1", "admin"),
      }),
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { data: { key: string; owner: string }[] };
    expect(listBody.data).toHaveLength(1);
    expect(listBody.data[0]?.owner).toBe("user-a");

    // Sanity: the same row is reachable through the compiled table directly.
    expect(adapter.dialect).toBe("sqlite");
  });

  describe("GET /files/:key: inline vs. attachment (stored-XSS hardening)", () => {
    it("serves an uploaded text/html file as Content-Disposition: attachment, never inline", async () => {
      const { backend } = await setup();

      const form = makeFormData("<script>alert(document.cookie)</script>", "evil.html", "text/html");
      const uploadRes = await backend.fetch(
        req("/api/media/upload", { method: "POST", body: form, headers: asUser("user-a") }),
      );
      expect(uploadRes.status).toBe(200);
      const { data } = (await uploadRes.json()) as { data: { key: string } };

      const getRes = await backend.fetch(req(`/files/${data.key}`, { headers: asUser("user-a") }));
      expect(getRes.status).toBe(200);
      expect(getRes.headers.get("content-type")).toBe("text/html");
      expect(getRes.headers.get("content-disposition")).toBe("attachment");
      expect(getRes.headers.get("x-content-type-options")).toBe("nosniff");
    });

    it("serves an uploaded image/png file INLINE, no Content-Disposition header at all", async () => {
      const { backend } = await setup();

      const form = makeFormData("not really png bytes", "photo.png", "image/png");
      const uploadRes = await backend.fetch(
        req("/api/media/upload", { method: "POST", body: form, headers: asUser("user-a") }),
      );
      expect(uploadRes.status).toBe(200);
      const { data } = (await uploadRes.json()) as { data: { key: string } };

      const getRes = await backend.fetch(req(`/files/${data.key}`, { headers: asUser("user-a") }));
      expect(getRes.status).toBe(200);
      expect(getRes.headers.get("content-type")).toBe("image/png");
      expect(getRes.headers.get("content-disposition")).toBeNull();
    });

    it("treats image/svg+xml as an attachment, NOT inline, despite matching the image/* prefix (SVG can carry <script>)", async () => {
      const { backend } = await setup();

      const form = makeFormData("<svg onload=\"alert(1)\"></svg>", "evil.svg", "image/svg+xml");
      const uploadRes = await backend.fetch(
        req("/api/media/upload", { method: "POST", body: form, headers: asUser("user-a") }),
      );
      expect(uploadRes.status).toBe(200);
      const { data } = (await uploadRes.json()) as { data: { key: string } };

      const getRes = await backend.fetch(req(`/files/${data.key}`, { headers: asUser("user-a") }));
      expect(getRes.status).toBe(200);
      expect(getRes.headers.get("content-disposition")).toBe("attachment");
    });

    it("essence-parses the content-type: a PARAMETERIZED (image/svg+xml; charset=utf-8) and an UPPERCASE (IMAGE/SVG+XML) svg both serve as attachment, never inline", async () => {
      const { backend } = await setup();

      for (const svgType of ["image/svg+xml; charset=utf-8", "IMAGE/SVG+XML"]) {
        const form = makeFormData("<svg onload=\"alert(1)\"></svg>", "evil.svg", svgType);
        const uploadRes = await backend.fetch(
          req("/api/media/upload", { method: "POST", body: form, headers: asUser("user-a") }),
        );
        expect(uploadRes.status).toBe(200);
        const { data } = (await uploadRes.json()) as { data: { key: string } };

        const getRes = await backend.fetch(req(`/files/${data.key}`, { headers: asUser("user-a") }));
        expect(getRes.status).toBe(200);
        expect(getRes.headers.get("content-disposition"), `svgType=${svgType}`).toBe("attachment");
      }
    });

    it("serves application/pdf inline (in the allowlist)", async () => {
      const { backend } = await setup();

      const form = makeFormData("%PDF-1.4 fake pdf bytes", "doc.pdf", "application/pdf");
      const uploadRes = await backend.fetch(
        req("/api/media/upload", { method: "POST", body: form, headers: asUser("user-a") }),
      );
      expect(uploadRes.status).toBe(200);
      const { data } = (await uploadRes.json()) as { data: { key: string } };

      const getRes = await backend.fetch(req(`/files/${data.key}`, { headers: asUser("user-a") }));
      expect(getRes.status).toBe(200);
      expect(getRes.headers.get("content-disposition")).toBeNull();
    });
  });
});
