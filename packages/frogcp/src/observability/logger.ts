/**
 * Cross-runtime structured logging for the frogCP kernel. No `node:` imports,
 * so it works identically on Cloudflare Workers, Node, and any other runtime
 * `@frogcp/adapter-*` targets: it is built entirely from `console` plus plain
 * objects (WebCrypto's `crypto.randomUUID()` is used elsewhere for the
 * correlation id, not here).
 *
 * This is the one logging abstraction the kernel, `EventBus`, and the REST
 * routes funnel their request-path `console.*` calls through (see `kernel.ts`'s
 * `resolveCtx`/the multi-identify boot warning, `events.ts`'s `EventBus.emit`,
 * and `api/routes.ts`'s 500 handler). Everything else (adapter
 * construction-time warnings for D1/libsql, migrate's destructive-statement
 * warning when no logger is threaded through) is either pre-kernel or out of
 * scope; see each call site's own comment.
 */

import type { LogRecord } from "./types";

/** Severity, ordered low to high for level-filtering (see `LEVEL_ORDER`). */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * The kernel's logging contract. Every method is synchronous and must not
 * throw, so a logging call is never the reason a request fails. `fields` is
 * free-form structured context merged into the emitted line.
 */
export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  /**
   * Returns a new `Logger` that merges `bindings` into every line it emits (on
   * top of the parent's bindings and any per-call `fields`), used for
   * request-scoped context like `{ requestId }`. `bindings` never mutate the
   * parent; `child` is purely additive and can be chained
   * (`logger.child(a).child(b)` carries both `a` and `b`).
   */
  child(bindings: Record<string, unknown>): Logger;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** The `console` method each level is emitted through. */
const CONSOLE_METHOD: Record<LogLevel, "debug" | "info" | "warn" | "error"> = {
  debug: "debug",
  info: "info",
  warn: "warn",
  error: "error",
};

export interface ConsoleLoggerOptions {
  /** Lines below this level are no-ops. Defaults to `"info"`. */
  level?: LogLevel;
  /** Dev-friendly single-line text instead of a JSON line. Defaults to `false`. */
  pretty?: boolean;
}

function formatPretty(level: LogLevel, time: string, message: string, fields: Record<string, unknown>): string {
  const rest = Object.entries(fields)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
  return rest.length > 0 ? `${time} [${level.toUpperCase()}] ${message} ${rest}` : `${time} [${level.toUpperCase()}] ${message}`;
}

/**
 * Optional per-record callback `makeLogger` invokes with the same merged
 * `LogRecord` it builds for console output. This is the seam
 * `consoleLoggerWithTee` (below) uses to forward every emitted line to an
 * `ObservabilityRegistry` (see `registry.ts`'s `emitLog`) in addition to the
 * console/pretty output, so bound `requestId`/`clientRequestId` (and any other
 * `child()` bindings) reach sinks exactly as they reach the console. It must
 * not throw, same as every other logging call here; a misbehaving `onEmit`
 * would otherwise take down request logging. `consoleLogger`/`silentLogger`
 * never pass one, so their behavior is unchanged from before this callback
 * existed.
 */
type OnEmit = (record: LogRecord) => void;

function makeLogger(bindings: Record<string, unknown>, minLevel: LogLevel, pretty: boolean, onEmit?: OnEmit): Logger {
  const emit = (level: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
    // `new Date()` is used elsewhere (see `data/engine.ts`'s auto-field
    // stamping) and is available on every runtime frogCP targets (Workers
    // included), so it's safe for the log line's own timestamp too.
    const time = new Date().toISOString();
    const merged = { ...bindings, ...fields };
    if (pretty) {
      console[CONSOLE_METHOD[level]](formatPretty(level, time, message, merged));
    } else {
      const line = { level, time, message, ...merged };
      console[CONSOLE_METHOD[level]](JSON.stringify(line));
    }
    if (onEmit) {
      try {
        onEmit({ level, time, message, fields: merged });
      } catch {
        // Never let a broken tee (or a broken downstream sink it forwards to)
        // break logging itself; see `OnEmit`'s doc comment above.
      }
    }
  };

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child: (childBindings) => makeLogger({ ...bindings, ...childBindings }, minLevel, pretty, onEmit),
  };
}

/**
 * The default `Logger`: emits one JSON object per line (`{ level, time,
 * message, ...bindings, ...fields }`) to the console method matching its level
 * (`console.debug`/`console.info`/`console.warn`/`console.error`). Lines below
 * `opts.level` (default `"info"`) are no-ops. `opts.pretty` swaps the JSON line
 * for a short human-readable one (dev convenience).
 */
export function consoleLogger(opts: ConsoleLoggerOptions = {}): Logger {
  return makeLogger({}, opts.level ?? "info", opts.pretty ?? false);
}

/**
 * Internal factory `createBackend` uses to build its backend logger: exactly
 * `consoleLogger`'s behavior (same console/pretty output, same level
 * filtering), plus a tee of every emitted `LogRecord` to `onEmit`. The kernel
 * passes `(record) => kernelCtx.observability.emitLog(record)` so every log
 * line (via the request-scoped `child()` logger too, since `onEmit` threads
 * through `child()`) also reaches any registered `LogSink`s. Not re-exported
 * from the package's public `index.ts`: this is kernel plumbing, not part of
 * the standalone-logger public API that `consoleLogger`/`silentLogger` cover.
 */
export function consoleLoggerWithTee(opts: ConsoleLoggerOptions, onEmit: OnEmit): Logger {
  return makeLogger({}, opts.level ?? "info", opts.pretty ?? false, onEmit);
}

/** A `Logger` that never emits anything, for tests that don't care about log output. */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
