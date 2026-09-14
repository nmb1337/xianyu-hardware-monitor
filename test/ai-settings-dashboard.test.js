import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { createApplication } from "../src/server.js";
import { XianyuBrowser } from "../src/browser.js";

const executablePath = new XianyuBrowser({ dataDirectory: "." }).executablePath;
let chrome;
before(async () => {
  if (executablePath) {
    chrome = await chromium.launch({ executablePath, headless: true });
  }
});
after(async () => chrome?.close());

for (const width of [1440, 390]) {
  test(`AI toggle persists, cancels requests, and survives stale polling at ${width}px`, {
    skip: !executablePath, timeout: 20_000
  }, async (t) => {
    const app = createApplication({ databasePath: ":memory:" });
    const context = await chrome.newContext({ viewport: { width, height: 1000 }, serviceWorkers: "block" });
    let releaseStale;
    t.after(async () => {
      releaseStale?.();
      app.services.ai.cancelPending();
      await context.close();
      await app.close();
      await new Promise((done) => {
        app.server.close(done);
        app.server.closeAllConnections();
      });
    });
    app.services.database.updateSettings({
      aiEnabled: true, aiBaseUrl: "https://relay.example/v1", aiModel: "saved-model", aiApiKey: "saved-key"
    });
    app.server.listen(0, "127.0.0.1");
    await once(app.server, "listening");
    const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
    await context.addInitScript(() => {
      const original = window.setInterval;
      window.setInterval = (callback, delay, ...args) => {
        if (delay === 5000) {
          window.pollMonitor = callback;
          return 0;
        }
        return original(callback, delay, ...args);
      };
    });
    let holdSettings = false;
    let failNextSave = false;
    let staleEntered;
    const staleStarted = new Promise((done) => { staleEntered = done; });
    const staleReleased = new Promise((done) => { releaseStale = done; });
    await context.route(`${baseUrl}/api/settings`, async (route) => {
      if (failNextSave && route.request().method() === "PUT") {
        failNextSave = false;
        return route.fulfill({ status: 503, json: { error: "Test save failure" } });
      }
      if (holdSettings && route.request().method() === "GET") {
        holdSettings = false;
        const snapshot = app.services.database.getPublicSettings();
        staleEntered();
        await staleReleased;
        return route.fulfill({ json: snapshot });
      }
      return route.continue();
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(baseUrl);
    await page.waitForFunction(() => window.pollMonitor && document.querySelector("#ai-enabled").checked);
    const toggle = page.locator("#ai-enabled");

    let aiEntered;
    const aiStarted = new Promise((done) => { aiEntered = done; });
    app.services.ai.options.fetchImpl = (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      aiEntered();
    });
    await page.locator("#test-ai").click();
    await aiStarted;
    await page.locator("#ai-model").fill("unsaved-model");
    await page.locator("#ai-api-key").fill("unsaved-key");
    holdSettings = true;
    const oldPoll = page.evaluate(() => window.pollMonitor());
    await staleStarted;
    await toggle.uncheck();
    await page.waitForFunction(() => !document.querySelector("#ai-enabled").disabled
      && document.querySelector("#ai-review-state").textContent === "未启用");
    releaseStale();
    await oldPoll;
    await page.waitForFunction(() => !document.querySelector("#test-ai").disabled);
    await page.evaluate(() => window.pollMonitor());
    assert.equal(await toggle.isChecked(), false);
    assert.equal(app.services.database.getSetting("ai_enabled"), "0");
    assert.equal(app.services.ai.pendingRequests.size, 0);
    assert.equal(await page.locator("#ai-model").inputValue(), "unsaved-model");
    assert.equal(await page.locator("#ai-api-key").inputValue(), "unsaved-key");
    assert.equal(app.services.database.getSetting("ai_model"), "saved-model");
    assert.equal(app.services.database.getSetting("ai_api_key"), "saved-key");

    await page.reload();
    await page.waitForFunction(() => window.pollMonitor && document.querySelector("#ai-model").value === "saved-model");
    assert.equal(await toggle.isChecked(), false);
    await toggle.check();
    await page.waitForFunction(() => !document.querySelector("#ai-enabled").disabled
      && document.querySelector("#ai-review-state").textContent === "已启用");
    assert.equal(app.services.database.getSetting("ai_enabled"), "1");
    failNextSave = true;
    await toggle.click();
    await page.waitForFunction(() => !document.querySelector("#ai-enabled").disabled
      && document.querySelector("#ai-enabled").checked
      && document.querySelector("#toast").textContent === "Test save failure");
    assert.equal(app.services.database.getSetting("ai_enabled"), "1");
    assert.equal(await page.locator("#toast").innerText(), "Test save failure");
    await page.locator("#ai-model").fill("updated-model");
    await page.locator("#ai-settings-form button[type='submit']").click();
    await page.waitForFunction(() => document.querySelector("#toast").textContent === "AI 设置已保存。");
    await page.evaluate(() => window.pollMonitor());
    assert.equal(app.services.database.getSetting("ai_model"), "updated-model");
    assert.equal(await page.locator("#ai-model").inputValue(), "updated-model");
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const directory = resolve("work", "ai-settings-ui");
    mkdirSync(directory, { recursive: true });
    await page.locator("#ai-settings-form").screenshot({ path: resolve(directory, `${width}.png`) });
  });
}
