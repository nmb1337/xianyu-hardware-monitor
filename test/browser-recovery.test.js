import test from "node:test";
import assert from "node:assert/strict";
import { isClosedTargetError, isVerificationOverlayError } from "../src/browser.js";

test("isClosedTargetError recognizes Playwright closed-target failures", () => {
  assert.equal(
    isClosedTargetError(new Error("page.goto: Target page, context or browser has been closed")),
    true
  );
  assert.equal(isClosedTargetError(new Error("Timeout 30000ms exceeded")), false);
});

test("isVerificationOverlayError recognizes the Xianyu Baxia verification mask", () => {
  assert.equal(
    isVerificationOverlayError(
      new Error("locator.click: <div class=\"baxia-dialog-mask\"></div> intercepts pointer events")
    ),
    true
  );
  assert.equal(isVerificationOverlayError(new Error("locator.click: Timeout 8000ms exceeded")), false);
});
