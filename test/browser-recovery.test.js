import test from "node:test";
import assert from "node:assert/strict";
import { isClosedTargetError } from "../src/browser.js";

test("isClosedTargetError recognizes Playwright closed-target failures", () => {
  assert.equal(
    isClosedTargetError(new Error("page.goto: Target page, context or browser has been closed")),
    true
  );
  assert.equal(isClosedTargetError(new Error("Timeout 30000ms exceeded")), false);
});
