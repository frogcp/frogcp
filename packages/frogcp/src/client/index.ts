export const VERSION = "0.0.1";

export { createClient } from "./client";
export type {
  AuthClient,
  AuthUser,
  Client,
  CreateClientOptions,
  DefaultBackend,
  EntityClient,
  EntityShape,
  FrogFetch,
  ListResult,
  LoginInput,
  MediaClient,
  RegisterInput,
  SchemaClient,
  SchemaResponse,
  UploadResult,
} from "./client";

export { buildClientError, FrogClientError } from "./errors";

export { encodeListQuery } from "./query";
export type { FilterOp, FilterOpMap, FilterScalar, FilterValue, ListQueryInput } from "./query";
