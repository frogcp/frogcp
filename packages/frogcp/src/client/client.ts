import { buildClientError } from "./errors";
import { encodeListQuery, type ListQueryInput } from "./query";

/**
 * The function shape `createClient` needs from a fetch implementation: takes a
 * single, already-built `Request` and returns a `Response`. This is narrower
 * than the DOM `typeof fetch` (which also accepts a bare URL plus a separate
 * `init`) on purpose: the client always builds a full `Request` itself, so it
 * never needs the two-argument form. The narrow type is what lets a real
 * backend's `Backend["fetch"]` (`(req: Request) => Promise<Response>`) plug in
 * directly with no adapter shim.
 */
export type FrogFetch = (request: Request) => Promise<Response>;

/** The `{ row, insert, patch }` shape one entity of a generated `ClientBackend`
 * contributes. `createClient` is generic over a `Record<string, EntityShape>`
 * structurally and never imports the server's own type, so any matching type
 * (generated or hand-written) works. */
export interface EntityShape {
  row: unknown;
  insert: unknown;
  patch: unknown;
}

/** The untyped default `createClient` falls back to when no `TBackend` type
 * argument is supplied: every entity name is accepted, and every row/insert/
 * patch is `unknown`. */
export type DefaultBackend = Record<string, EntityShape>;

export interface ListResult<Row> {
  data: Row[];
  meta: { total: number; limit: number; offset: number };
}

export interface EntityClient<E extends EntityShape> {
  list(query?: ListQueryInput): Promise<ListResult<E["row"]>>;
  get(id: string, opts?: { with?: readonly string[] }): Promise<E["row"]>;
  create(data: E["insert"]): Promise<E["row"]>;
  update(id: string, patch: E["patch"]): Promise<E["row"]>;
  delete(id: string): Promise<void>;
}

/** The public-safe user shape `frogcp/auth`'s routes return: `passwordHash`
 * never appears on the wire. */
export interface AuthUser {
  id: string;
  email: string;
  name?: string | null;
  role: string;
  createdAt: string;
}

export interface RegisterInput {
  email: string;
  password: string;
  name?: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface AuthClient {
  register(input: RegisterInput): Promise<{ user: AuthUser }>;
  login(input: LoginInput): Promise<{ user: AuthUser }>;
  logout(): Promise<{ ok: boolean }>;
  me(): Promise<{ user: AuthUser }>;
}

export interface UploadResult {
  key: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface MediaClient {
  /** `POST`s a multipart `file` field to `/api/media/upload`. `opts.filename`
   * overrides the name sent for a bare `Blob` (which has no `.name` of its
   * own); a `File`'s own name is used otherwise. */
  upload(file: File | Blob, opts?: { filename?: string }): Promise<UploadResult>;
  /** The public download URL for a previously-uploaded `key`. `GET` it
   * directly (e.g. as an `<img src>`); it is not fetched through the client. */
  url(key: string): string;
}

/**
 * The schema shape `GET`/`POST /api/system/schema` return. Typed loosely
 * (`entities` values are `unknown`) rather than importing the server's own
 * `EntitySchemaSummary`, since the client has no runtime dependency on the
 * server. `mode` is the one field callers branch on (whether schema editing is
 * possible); a caller that needs the rest can narrow or cast it.
 */
export interface SchemaResponse {
  data: { entities: Record<string, unknown> };
  mode: "code" | "managed";
}

export interface SchemaClient {
  /** `GET /api/system/schema`. Admin-only; a non-admin caller's promise
   * rejects with a `FrogClientError` (403). */
  get(): Promise<SchemaResponse>;
  /**
   * `POST /api/system/schema`. Admin-only; edits the schema (managed mode
   * only). `config` is a full user-entity config, the shape `serializeConfig`
   * emits, not the merged shape `get()` returns. Untyped (`unknown`) for the
   * same reason `SchemaResponse` is loose.
   *
   * Rejects with `FrogClientError`: `403` (non-admin), `409` (the backend is
   * running in code mode, where schema editing is not allowed), or `422` (the
   * config is malformed or its migration failed). `.message` carries the
   * server's human-readable reason in every case.
   */
  update(config: unknown): Promise<SchemaResponse>;
}

export interface Client<TBackend extends DefaultBackend = DefaultBackend> {
  entity<K extends keyof TBackend & string>(name: K): EntityClient<TBackend[K]>;
  auth: AuthClient;
  media: MediaClient;
  schema: SchemaClient;
}

export interface CreateClientOptions {
  /** Defaults to `globalThis.fetch`. Pass a `Backend["fetch"]` to drive a real
   * backend with zero network; see `FrogFetch` for why that plugs in
   * directly. */
  fetch?: FrogFetch;
  /** Merged into every request (e.g. `{ Authorization: "Bearer ..." }` for
   * callers that cannot rely on cookies). */
  headers?: Record<string, string>;
  /** Defaults to `"include"` (send/receive cookies, the browser session-cookie
   * flow `frogcp/auth` issues). Set to `"same-origin"`/`"omit"` to opt out. */
  credentials?: RequestCredentials;
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Builds a typed frogCP HTTP client. Runtime-agnostic (fetch-only, no `node:`
 * imports), so it works in the browser, Node, Workers, and React Native alike.
 * `TBackend` (typically `frogcp generate`'s emitted `ClientBackend`) types
 * `client.entity(name)`'s row/insert/patch shapes; omit it and every entity
 * call is `unknown`-typed but still works.
 */
export function createClient<TBackend extends DefaultBackend = DefaultBackend>(
  baseUrl: string,
  opts: CreateClientOptions = {},
): Client<TBackend> {
  const base = trimTrailingSlash(baseUrl);
  const fetchImpl: FrogFetch = opts.fetch ?? (globalThis.fetch.bind(globalThis) as FrogFetch);
  const baseHeaders = opts.headers ?? {};
  const credentials: RequestCredentials = opts.credentials ?? "include";

  /** Issues a JSON request (or a bodyless GET/DELETE when `json` is
   * `undefined`) and returns the parsed JSON body, or `undefined` for an empty
   * body (e.g. a `204 No Content` delete). Throws `FrogClientError` for any
   * non-2xx response. */
  async function apiRequest<T>(path: string, method: string, json?: unknown): Promise<T> {
    const headers = new Headers(baseHeaders);
    // `body` is built up rather than passed as a literal: `RequestInit["body"]`
    // is `BodyInit | null` (no `undefined`), and `exactOptionalPropertyTypes`
    // forbids assigning `undefined` to an optional property, so `body` is only
    // set on `init` when there actually is one.
    const init: RequestInit = { method, headers, credentials };
    if (json !== undefined) {
      init.body = JSON.stringify(json);
      headers.set("content-type", "application/json");
    }

    const request = new Request(`${base}${path}`, init);
    const res = await fetchImpl(request);
    if (!res.ok) throw await buildClientError(res);

    const text = await res.text();
    return text.length > 0 ? (JSON.parse(text) as T) : (undefined as T);
  }

  /** Issues a `multipart/form-data` `POST`. Deliberately never sets a
   * `content-type` header itself, so `fetch`/`Request` computes the multipart
   * boundary from the `FormData` body (setting it manually would omit the
   * boundary parameter and break server-side parsing). */
  async function apiRequestForm<T>(path: string, form: FormData): Promise<T> {
    const headers = new Headers(baseHeaders);
    const request = new Request(`${base}${path}`, { method: "POST", headers, body: form, credentials });
    const res = await fetchImpl(request);
    if (!res.ok) throw await buildClientError(res);

    const text = await res.text();
    return text.length > 0 ? (JSON.parse(text) as T) : (undefined as T);
  }

  function entity<K extends keyof TBackend & string>(name: K): EntityClient<TBackend[K]> {
    type Row = TBackend[K]["row"];
    type Insert = TBackend[K]["insert"];
    type Patch = TBackend[K]["patch"];

    return {
      async list(query) {
        return apiRequest<ListResult<Row>>(`/api/entity/${name}${encodeListQuery(query)}`, "GET");
      },
      async get(id, getOpts) {
        const withQs = encodeListQuery(getOpts?.with ? { with: getOpts.with } : undefined);
        const res = await apiRequest<{ data: Row }>(`/api/entity/${name}/${encodeURIComponent(id)}${withQs}`, "GET");
        return res.data;
      },
      async create(data: Insert) {
        const res = await apiRequest<{ data: Row }>(`/api/entity/${name}`, "POST", data);
        return res.data;
      },
      async update(id, patch: Patch) {
        const res = await apiRequest<{ data: Row }>(`/api/entity/${name}/${encodeURIComponent(id)}`, "PATCH", patch);
        return res.data;
      },
      async delete(id) {
        await apiRequest<undefined>(`/api/entity/${name}/${encodeURIComponent(id)}`, "DELETE");
      },
    };
  }

  const auth: AuthClient = {
    async register(input) {
      const res = await apiRequest<{ data: { user: AuthUser } }>("/api/auth/register", "POST", input);
      return res.data;
    },
    async login(input) {
      const res = await apiRequest<{ data: { user: AuthUser } }>("/api/auth/login", "POST", input);
      return res.data;
    },
    async logout() {
      const res = await apiRequest<{ data: { ok: boolean } }>("/api/auth/logout", "POST");
      return res.data;
    },
    async me() {
      const res = await apiRequest<{ data: { user: AuthUser } }>("/api/auth/me", "GET");
      return res.data;
    },
  };

  const media: MediaClient = {
    async upload(file, uploadOpts) {
      const filename = uploadOpts?.filename ?? (file instanceof File ? file.name : "file");
      const form = new FormData();
      form.append("file", file, filename);
      const res = await apiRequestForm<{ data: UploadResult }>("/api/media/upload", form);
      return res.data;
    },
    url(key) {
      return `${base}/files/${encodeURIComponent(key)}`;
    },
  };

  const schema: SchemaClient = {
    async get() {
      return apiRequest<SchemaResponse>("/api/system/schema", "GET");
    },
    async update(config) {
      return apiRequest<SchemaResponse>("/api/system/schema", "POST", config);
    },
  };

  return { entity, auth, media, schema };
}
