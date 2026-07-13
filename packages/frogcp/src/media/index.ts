import type { FrogPlugin } from "frogcp";
import { buildFilesEntities } from "./entities";
import { registerMediaRoutes } from "./routes";

export const VERSION = "0.0.1";

export { FILES_ENTITY, buildFilesEntities } from "./entities";

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB
const DEFAULT_ROUTE = "/api/media";

export interface MediaPluginOptions {
  /** Rejects an upload over this many bytes with a 413 payload_too_large. Defaults to 10 MiB. */
  maxBytes?: number;
  /** Base path the upload endpoint is mounted under (POST {route}/upload). Defaults to "/api/media". GET /files/:key is always mounted at that fixed path regardless of this option. */
  route?: string;
  /**
   * When true (the default), read/delete on a file are restricted to its
   * uploader (rule.owner("owner")), so files are private by default. When
   * false, any caller (including guests) may fetch or remove any file by key.
   * Uploading itself always requires an authenticated caller.
   */
  ownerScoped?: boolean;
}

/**
 * Builds the media plugin: it contributes the media_files entity and the
 * POST {route}/upload and GET /files/:key routes, storing bytes through
 * KernelContext.storage (the StorageAdapter that createBackend's storage
 * option populates).
 *
 * onBoot asserts storage is configured so a missing adapter fails at
 * createBackend time with a clear error rather than on the first upload.
 * storage is set once before any plugin runs, so this check is sufficient.
 */
export function mediaPlugin(opts: MediaPluginOptions = {}): FrogPlugin {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const route = opts.route ?? DEFAULT_ROUTE;
  const ownerScoped = opts.ownerScoped ?? true;

  return {
    name: "media",
    entities: buildFilesEntities(ownerScoped),
    onBoot(kernelCtx) {
      if (!kernelCtx.storage) {
        throw new Error("mediaPlugin requires a storage adapter: pass `storage` to createBackend");
      }
    },
    routes(app, kernelCtx) {
      registerMediaRoutes(app, kernelCtx, { maxBytes, route });
    },
  };
}
