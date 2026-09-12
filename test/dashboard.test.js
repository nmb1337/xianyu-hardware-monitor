import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { XianyuBrowser } from "../src/browser.js";

const executablePath = new XianyuBrowser({ dataDirectory: "." }).executablePath;
let chrome;
before(async () => {
  if (executablePath) {
    chrome = await chromium.launch({ executablePath, headless: true });
  }
});
after(async () => chrome?.close());

for (const [name, width, running, accessPaused] of [
  ["desktop-paused", 1440, false, true],
  ["mobile-running", 390, true, false],
  ["mobile-stopped", 320, false, false]
]) {
  test(`dashboard schedule and controls render correctly: ${name}`, { skip: !executablePath }, async (t) => {
    const context = await chrome.newContext({
      viewport: { width, height: 1000 },
      serviceWorkers: "block"
    });
    t.after(() => context.close());
    const status = {
      running, accessPaused, activeRuleId: null, astrbotConfigured: false,
      nextSearchAt: Date.now() + 5_400_000,
      searchIntervalMinMs: 5_400_000, searchIntervalMaxMs: 7_200_000,
      lastActivity: accessPaused ? "访问验证后已暂停" : "等待搜索",
      browser: { available: true, state: "not_started", executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" }
    };
    const rules = Array.from({ length: 5 }, (_, index) => ({
      id: index + 1, name: `GPU ${index}`, keyword: `GPU ${index}`, category: "gpu",
      minPriceCny: 500, maxPriceCny: 1500, scanIntervalSeconds: 300,
      enabled: true, personalOnly: true, includeTerms: [], excludeTerms: []
    }));
    const payloads = {
      "/api/categories": [{ value: "gpu", label: "显卡" }],
      "/api/status": status,
      "/api/rules": rules,
      "/api/listings": [],
      "/api/blocked-listings": [],
      "/api/notifications": [],
      "/api/settings": { aiEnabled: false }
    };
    const files = { "/": "index.html", "/app.js": "app.js", "/styles.css": "styles.css" };
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== "http://monitor.test" || route.request().method() !== "GET") {
        return route.abort();
      }
      if (url.pathname in payloads) {
        return route.fulfill({ json: payloads[url.pathname] });
      }
      const filename = files[url.pathname];
      if (!filename) {
        return route.abort();
      }
      return route.fulfill({
        body: readFileSync(resolve("public", filename)),
        contentType: filename.endsWith(".js") ? "text/javascript"
          : filename.endsWith(".css") ? "text/css" : "text/html; charset=utf-8"
      });
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("http://monitor.test/");
    await page.waitForFunction(() => document.querySelector("#rules-body").children.length === 5);
    assert.match(await page.locator("#rotation-estimate").innerText(), /7.5-10/);
    assert.equal(await page.locator('[data-action="scan"]:disabled').count(), 5);
    assert.equal(await page.locator("#start-monitor").isDisabled(), running);
    assert.equal(await page.locator("#stop-monitor").isDisabled(), !running);
    assert.equal(await page.locator("#resume-monitor").isDisabled(), !accessPaused);
    assert.equal(await page.locator("#ai-enabled").isChecked(), false);
    assert.match(
      await page.locator("#search-schedule").innerText(),
      accessPaused ? /已暂停/ : running ? /搜索时段/ : /未启动/
    );
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false);
    assert.deepEqual(errors, []);
    const directory = resolve("work", "schedule-ui");
    mkdirSync(directory, { recursive: true });
    await page.screenshot({ path: resolve(directory, `${name}.png`), fullPage: true });
  });
}
