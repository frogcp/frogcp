// Loaded for every test file in this package, including the non-jsdom suites:
// registering matchers doesn't touch `document` until one is actually called.
import "@testing-library/jest-dom/vitest";

import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// jsdom has no `ResizeObserver`, but Radix's `Switch` constructs one on mount.
// A stub whose callback never fires is enough, since nothing here resizes or
// asserts on layout.
if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

// `@testing-library/react`'s auto-cleanup only self-registers when it finds a
// GLOBAL `afterEach`, and this repo deliberately doesn't enable vitest globals.
// Without this, DOM from one test leaks into the next test's `screen` queries.
afterEach(() => cleanup());
