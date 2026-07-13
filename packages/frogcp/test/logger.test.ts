import { describe, it, expect, vi } from "vitest";
import { nodeSqliteAdapter } from "./support/node-sqlite-adapter";
import {
  consoleLogger,
  silentLogger,
  createBackend,
  defineBackend,
  entity,
  text,
  rule,
  type DatabaseAdapter,
  type FrogPlugin,
  type Logger,
} from "../src/index";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface CapturedLine {
  level: string;
  message: string;
  fields?: Record<string, unknown>;
}

/** A minimal Logger that records every call into sink. Same helper as plugins.test.ts. */
function makeCapturingLogger(sink: CapturedLine[], bindings: Record<string, unknown> = {}): Logger {
  const record = (level: string, message: string, fields?: Record<string, unknown>) => {
    sink.push({ level, message, fields: { ...bindings, ...fields } });
  };
  return {
    debug: (message, fields) => record("debug", message, fields),
    info: (message, fields) => record("info", message, fields),
    warn: (message, fields) => record("warn", message, fields),
    error: (message, fields) => record("error", message, fields),
    child: (childBindings) => makeCapturingLogger(sink, { ...bindings, ...childBindings }),
  };
}

const BASE = "http://x";

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`${BASE}${path}`, init);
}

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

const config = defineBackend({
  entities: {
    notes: entity({ title: text().required() }).permissions(publicPerms),
  },
});

describe("consoleLogger", () => {
  it("emits a single JSON line with level/time/message/fields to the matching console method", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const logger = consoleLogger();

    logger.info("hello", { foo: "bar" });

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(infoSpy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(line.level).toBe("info");
    expect(line.message).toBe("hello");
    expect(line.foo).toBe("bar");
    expect(typeof line.time).toBe("string");
    infoSpy.mockRestore();
  });

  it("routes warn/error to console.warn/console.error respectively", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = consoleLogger();

    logger.warn("a warning");
    logger.error("an error");

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("suppresses levels below the configured level (debug suppressed at the default 'info' level)", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const logger = consoleLogger(); // default level: "info"

    logger.debug("should not appear");
    logger.info("should appear");

    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledTimes(1);
    debugSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it("an explicit level option is honored (e.g. 'debug' lets debug lines through)", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const logger = consoleLogger({ level: "debug" });

    logger.debug("now visible");

    expect(debugSpy).toHaveBeenCalledTimes(1);
    debugSpy.mockRestore();
  });

  it("an explicit level option filters OUT lower levels too (e.g. 'error' suppresses warn)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = consoleLogger({ level: "error" });

    logger.warn("suppressed");
    logger.error("shown");

    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("child() merges its bindings into every line emitted by the child (and later fields still win on collision)", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const logger = consoleLogger();
    const child = logger.child({ requestId: "req-1", scope: "test" });

    child.info("line one");
    child.info("line two", { scope: "override" });

    const line1 = JSON.parse(infoSpy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    const line2 = JSON.parse(infoSpy.mock.calls[1]?.[0] as string) as Record<string, unknown>;
    expect(line1.requestId).toBe("req-1");
    expect(line1.scope).toBe("test");
    expect(line2.requestId).toBe("req-1");
    expect(line2.scope).toBe("override"); // per-call fields win over bound bindings
    infoSpy.mockRestore();
  });

  it("child() is additive and does not mutate the parent logger", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const logger = consoleLogger();
    logger.child({ a: 1 });

    logger.info("parent line");

    const line = JSON.parse(infoSpy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(line.a).toBeUndefined();
    infoSpy.mockRestore();
  });
});

describe("silentLogger", () => {
  it("never calls any console method, at any level", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    silentLogger.debug("x");
    silentLogger.info("x");
    silentLogger.warn("x");
    silentLogger.error("x");
    silentLogger.child({ a: 1 }).error("still silent");

    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    debugSpy.mockRestore();
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe("request correlation", () => {
  it("every response carries an X-Request-Id header shaped like a uuid", async () => {
    const backend = await createBackend({ config, adapter: makeAdapter() });

    const res = await backend.fetch(req("/api/entity/notes"));

    const requestId = res.headers.get("X-Request-Id");
    expect(requestId).toBeTruthy();
    expect(requestId).toMatch(UUID_RE);
  });

  it("two different requests get two different request ids", async () => {
    const backend = await createBackend({ config, adapter: makeAdapter() });

    const res1 = await backend.fetch(req("/api/entity/notes"));
    const res2 = await backend.fetch(req("/api/entity/notes"));

    expect(res1.headers.get("X-Request-Id")).not.toBe(res2.headers.get("X-Request-Id"));
  });

  it("the per-request logger includes the response's requestId on every line it emits", async () => {
    const lines: CapturedLine[] = [];
    const testLogger = makeCapturingLogger(lines);
    const boom: FrogPlugin = {
      name: "boom",
      routes(app) {
        app.get("/api/log-something", (c) => {
          c.get("logger").info("handling request");
          return c.json({ ok: true }, 200);
        });
      },
    };
    const backend = await createBackend({ config, adapter: makeAdapter(), logger: testLogger, plugins: [boom] });

    const res = await backend.fetch(req("/api/log-something"));
    const requestId = res.headers.get("X-Request-Id");

    const line = lines.find((l) => l.message === "handling request");
    expect(line).toBeDefined();
    expect(line?.fields?.requestId).toBe(requestId);
  });

  it("an incoming X-Request-Id is never trusted as the response id (spoofing is rejected)", async () => {
    const backend = await createBackend({ config, adapter: makeAdapter() });
    const spoofed = "spoofed-id-0000000000";

    const res = await backend.fetch(req("/api/entity/notes", { headers: { "X-Request-Id": spoofed } }));

    const responseId = res.headers.get("X-Request-Id");
    expect(responseId).not.toBe(spoofed);
    expect(responseId).toMatch(UUID_RE);
  });

  it("a sanitized copy of an incoming X-Request-Id is recorded as clientRequestId on the request logger, never as the id itself", async () => {
    const lines: CapturedLine[] = [];
    const testLogger = makeCapturingLogger(lines);
    const boom: FrogPlugin = {
      name: "boom",
      routes(app) {
        app.get("/api/log-something", (c) => {
          c.get("logger").info("handling request");
          return c.json({ ok: true }, 200);
        });
      },
    };
    const backend = await createBackend({ config, adapter: makeAdapter(), logger: testLogger, plugins: [boom] });
    const incoming = "client-supplied-id-123";

    const res = await backend.fetch(req("/api/log-something", { headers: { "X-Request-Id": incoming } }));
    const responseId = res.headers.get("X-Request-Id");

    const line = lines.find((l) => l.message === "handling request");
    expect(line?.fields?.clientRequestId).toBe(incoming);
    expect(line?.fields?.requestId).toBe(responseId);
    expect(responseId).not.toBe(incoming);
  });

  it("a malformed/unsafe incoming X-Request-Id (not alphanumeric+dash) is dropped rather than recorded", async () => {
    const lines: CapturedLine[] = [];
    const testLogger = makeCapturingLogger(lines);
    const boom: FrogPlugin = {
      name: "boom",
      routes(app) {
        app.get("/api/log-something", (c) => {
          c.get("logger").info("handling request");
          return c.json({ ok: true }, 200);
        });
      },
    };
    const backend = await createBackend({ config, adapter: makeAdapter(), logger: testLogger, plugins: [boom] });

    const res = await backend.fetch(
      req("/api/log-something", { headers: { "X-Request-Id": "not/safe_id!" } }),
    );
    expect(res.status).toBe(200);

    const line = lines.find((l) => l.message === "handling request");
    expect(line?.fields?.clientRequestId).toBeUndefined();
  });
});

describe("500 handler logs the real error server-side without leaking it to the client", () => {
  it("an injected logger captures the unhandled error; the client only ever sees the generic 500 envelope", async () => {
    const lines: CapturedLine[] = [];
    const testLogger = makeCapturingLogger(lines);
    const boom: FrogPlugin = {
      name: "boom",
      routes(app) {
        app.get("/api/boom", () => {
          throw new Error("kaboom: definitely-secret-internal-detail");
        });
      },
    };

    const backend = await createBackend({ config, adapter: makeAdapter(), logger: testLogger, plugins: [boom] });

    const res = await backend.fetch(req("/api/boom"));

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("internal");
    expect(body.error.message).not.toMatch(/kaboom/);
    expect(body.error.message).not.toMatch(/secret/i);

    const errorLine = lines.find((l) => l.message === "unhandled error");
    expect(errorLine).toBeDefined();
    expect(errorLine?.level).toBe("error");
    expect(String((errorLine?.fields?.error as Error)?.message)).toMatch(/kaboom/);
  });
});
