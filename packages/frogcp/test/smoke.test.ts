import { expect, test } from "vitest";
import { version } from "frogcp";

test("the package resolves from source", () => {
  expect(version).toBe("0.0.0");
});
