import test from "node:test";
import assert from "node:assert/strict";
import { XianyuBrowser, isClosedTargetError, isVerificationOverlayError } from "../src/browser.js";

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
  assert.equal(
    isVerificationOverlayError(new Error('locator.click: <div class="tooltip"> intercepts pointer events')),
    false
  );
});

test("failed browser closure retains the old context instead of allowing a second launch", async () => {
  const browser = new XianyuBrowser({ dataDirectory: "." });
  const context = { close: async () => { throw new Error("browser close failed"); } };
  const page = {};
  browser.context = context;
  browser.page = page;
  await assert.rejects(browser.close(), /browser close failed/);
  assert.equal(browser.context, context);
  assert.equal(browser.page, page);
  assert.equal(browser.status().browserOpen, true);
});

test("closing an already closed context clears the cached verified state without reopening", async () => {
  const browser = new XianyuBrowser({ dataDirectory: "." });
  browser.context = { close: async () => { throw new Error("Target page, context or browser has been closed"); } };
  browser.page = {};
  browser.loginState = "verified";
  await browser.close();
  assert.equal(browser.status().state, "not_started");
  assert.equal(browser.context, null);
  assert.equal(browser.page, null);
});

test("passive login verification never launches a closed browser or trusts stale state", async () => {
  const browser = new XianyuBrowser({ dataDirectory: "." });
  browser.loginState = "verified";
  browser.playwright = {
    launchPersistentContext: async () => { throw new Error("Unexpected launch"); }
  };
  const status = await browser.verifyLogin({ openIfNeeded: false });
  assert.equal(status.state, "waiting_for_login");
  assert.equal(status.browserOpen, false);
  assert.equal(browser.context, null);
});
