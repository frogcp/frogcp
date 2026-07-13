/**
 * Thrown for every non-2xx response the client receives. `code`/`message` are
 * parsed from the frogCP error envelope (`{ error: { code, message } }`). If a
 * response is not that shape (a non-frogCP proxy error, a body that is not
 * JSON), `code` falls back to `"unknown"` and `message` to the status text.
 */
export class FrogClientError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "FrogClientError";
    this.status = status;
    this.code = code;
  }
}

/** Builds a `FrogClientError` from a non-ok `Response`, parsing the frogCP
 * error envelope when present. Never throws itself: a body that fails to parse
 * as JSON falls back to `res.statusText`, so a caller always gets a
 * well-formed error either way. */
export async function buildClientError(res: Response): Promise<FrogClientError> {
  let code = "unknown";
  let message = res.statusText.length > 0 ? res.statusText : `Request failed with status ${res.status}`;

  try {
    const body: unknown = await res.json();
    if (body && typeof body === "object" && "error" in body) {
      const err = (body as { error?: unknown }).error;
      if (err && typeof err === "object") {
        const typed = err as { code?: unknown; message?: unknown };
        if (typeof typed.code === "string") code = typed.code;
        if (typeof typed.message === "string") message = typed.message;
      }
    }
  } catch {
    // Response body was not JSON (or was empty). Keep the statusText fallback.
  }

  return new FrogClientError(res.status, code, message);
}
