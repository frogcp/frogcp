import type { Hono } from "hono";
import { ApiError, decide, type ApiVariables, type KernelContext, type StorageAdapter } from "frogcp";
import { FILES_ENTITY } from "./entities";

export interface MediaRouteConfig {
  maxBytes: number;
  route: string;
}

/** The standard 404 envelope, used for both a missing row and a row denied by
 * the caller's read rule, so the two stay indistinguishable (no existence
 * oracle through GET /files/:key). */
function notFound(): Response {
  return Response.json({ error: { code: "not_found", message: "Not found" } }, { status: 404 });
}

/** onBoot throws before routes() ever runs when storage is absent, so this is
 * a defensive invariant check, not a real runtime path. */
function requireStorage(kernelCtx: KernelContext): StorageAdapter {
  const storage = kernelCtx.storage;
  if (!storage) {
    throw new Error('unreachable: mediaPlugin.onBoot guarantees "storage" is set before routes run');
  }
  return storage;
}

function filesEntityAndTable(kernelCtx: KernelContext) {
  const entityDef = kernelCtx.config.entities[FILES_ENTITY];
  const table = kernelCtx.tables[FILES_ENTITY];
  if (!entityDef || !table) {
    throw new Error(`unreachable: mediaPlugin always registers a "${FILES_ENTITY}" entity`);
  }
  return { entityDef, table };
}

/**
 * A sanitized file extension (leading dot, lowercased), or "" when filename
 * has none or the candidate is anything other than a short alphanumeric
 * suffix. Allowlisting is load-bearing: a filename like "a.b/etc/passwd" has a
 * last-dot suffix of ".b/etc/passwd", which would produce a storage key with a
 * slash the single-segment /files/:key route could never serve back (a silent
 * orphan) and a path-traversal hazard for a future filesystem adapter. A
 * leading dot with nothing before it (".gitignore") is not an extension either.
 */
function extensionOf(filename: string): string {
  const idx = filename.lastIndexOf(".");
  const ext = idx > 0 ? filename.slice(idx) : "";
  return /^\.[A-Za-z0-9]{1,15}$/.test(ext) ? ext.toLowerCase() : "";
}

/**
 * Content types safe to serve inline (rendered by the browser rather than
 * downloaded) from GET /files/:key. A small explicit allowlist, not a
 * denylist: image/*, video/*, audio/*, and application/pdf. Everything else is
 * served as an attachment.
 *
 * image/svg+xml is deliberately excluded despite matching image/*: an SVG can
 * embed <script> and event-handler attributes, so it is as dangerous as HTML
 * if rendered inline.
 *
 * The MIME essence is parsed out first (drop the parameters, trim, lowercase)
 * so a parameterized or uppercased "image/svg+xml; charset=utf-8" cannot fail
 * the exact svg check yet still pass startsWith("image/") and reopen the bypass.
 */
function isInlineSafe(contentType: string): boolean {
  const type = contentType.toLowerCase().split(";")[0]!.trim();
  if (type === "image/svg+xml") return false;
  if (type === "application/pdf") return true;
  return type.startsWith("image/") || type.startsWith("video/") || type.startsWith("audio/");
}

/**
 * Registers POST {route}/upload and GET /files/:key on the kernel's Hono app.
 * GET /files/:key is intentionally not prefixed by route: it is the public,
 * short, shareable download URL, independent of where the upload endpoint is
 * mounted.
 */
export function registerMediaRoutes(app: Hono<{ Variables: ApiVariables }>, kernelCtx: KernelContext, cfg: MediaRouteConfig): void {
  app.post(`${cfg.route}/upload`, async (c) => {
    const reqCtx = c.get("ctx");

    // Authorize before any request-body work: an unauthorized caller must
    // never reach formData() (which buffers the entire multipart body into
    // memory) or storage.put (no orphaned blob for a row that is never
    // inserted), and must not learn anything about the entity's shape.
    const { entityDef, table } = filesEntityAndTable(kernelCtx);
    const decision = decide(entityDef, "create", reqCtx, table);
    if (!decision.allow) {
      throw new ApiError(403, "forbidden", `Not allowed to create "${FILES_ENTITY}"`);
    }
    // decide only allows here for an admin role or a held authenticated()
    // rule, both of which imply a non-null ctx, so this is a defensive check.
    if (!reqCtx) {
      throw new Error('unreachable: "create" decision.allow implies reqCtx !== null (rule is authenticated())');
    }

    // Content-Length is a client hint, not authoritative (absent under chunked
    // transfer-encoding), but when present and over the limit it lets us reject
    // with 413 before formData() buffers any body. The post-parse file.size
    // check below still catches a missing or understated header.
    const contentLength = c.req.header("content-length");
    if (contentLength !== undefined) {
      const declaredBytes = Number(contentLength);
      if (Number.isFinite(declaredBytes) && declaredBytes > cfg.maxBytes) {
        throw new ApiError(413, "payload_too_large", `File exceeds the ${cfg.maxBytes}-byte limit`);
      }
    }

    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      throw new ApiError(422, "validation", "Expected a multipart/form-data body");
    }

    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new ApiError(422, "validation", 'Expected a "file" field containing a file');
    }
    if (file.size > cfg.maxBytes) {
      throw new ApiError(413, "payload_too_large", `File exceeds the ${cfg.maxBytes}-byte limit`);
    }

    const key = `${crypto.randomUUID()}${extensionOf(file.name)}`;
    const bytes = new Uint8Array(await file.arrayBuffer());

    const storage = requireStorage(kernelCtx);
    await storage.put(key, bytes, { contentType: file.type });

    const inserted = await kernelCtx.engine.create(
      FILES_ENTITY,
      {
        key,
        filename: file.name,
        contentType: file.type,
        size: bytes.byteLength,
        owner: reqCtx.userId,
      },
      reqCtx,
    );

    return c.json(
      {
        data: {
          key: inserted.key,
          filename: inserted.filename,
          contentType: inserted.contentType,
          size: inserted.size,
        },
      },
      200,
    );
  });

  app.get("/files/:key", async (c) => {
    const key = c.req.param("key");
    const reqCtx = c.get("ctx");

    // findByField applies the read filter and hidden-field stripping by an
    // arbitrary column, collapsing missing and denied into the same null, which
    // this route folds into the same 404 either way (no existence oracle).
    const row = await kernelCtx.engine.findByField(FILES_ENTITY, "key", key, reqCtx);
    if (!row) {
      return notFound();
    }

    const storage = requireStorage(kernelCtx);
    const bytes = await storage.get(row.key as string);
    if (!bytes) {
      return notFound();
    }

    const contentType = typeof row.contentType === "string" && row.contentType.length > 0 ? row.contentType : "application/octet-stream";

    // contentType is whatever the uploader's client declared (file.type, never
    // validated against the actual bytes), reflected back verbatim. nosniff
    // stops the browser from sniffing the body and executing it as HTML/script
    // regardless of the declared type. That alone is not enough: a type the
    // browser will render as a document (text/html, image/svg+xml, ...) still
    // runs same-origin script inline, so anything outside isInlineSafe's
    // allowlist is served as an attachment (downloaded, not rendered).
    const headers: Record<string, string> = { "content-type": contentType, "x-content-type-options": "nosniff" };
    if (!isInlineSafe(contentType)) {
      headers["content-disposition"] = "attachment";
    }
    // bytes is a freshly allocated Uint8Array; the cast satisfies BodyInit's
    // ArrayBuffer-backed view requirement, a type-level mismatch only.
    return new Response(bytes as Uint8Array<ArrayBuffer>, { headers });
  });
}
