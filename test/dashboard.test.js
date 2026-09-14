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
      enabledRuleCount: 5, nextRuleId: 1, nextRuleName: "GPU 0", lastScannedRuleId: null,
      lastActivity: accessPaused
        ? "旧窗口已关闭，即将自动切换到 Google Chrome 并打开登录窗口；确认登录有效后会自动继续查询。"
        : "等待搜索",
      accessPauseKind: accessPaused ? "verification" : "",
      recoveryState: accessPaused ? "checking" : "none",
      browser: {
        available: true, state: "not_started", canSwitch: true,
        alternateBrowserName: "Google Chrome",
        browserName: "Microsoft Edge",
        executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
      }
    };
    const rules = Array.from({ length: 5 }, (_, index) => ({
      id: index + 1, name: `GPU ${index}`, keyword: `GPU ${index}`, category: "gpu",
      minPriceCny: 500, maxPriceCny: 1500,
      enabled: true, personalOnly: true, includeTerms: [], excludeTerms: []
    }));
    const payloads = {
      "/api/categories": [{ value: "gpu", label: "显卡" }],
      "/api/status": status,
      "/api/rules": rules,
      "/api/listings": [],
      "/api/blocked-listings": [],
      "/api/notifications": [],
      "/api/settings": { aiEnabled: false },
      "/api/ai-rejections": [
        {
          itemId: "fixture", title: "RTX 3070 故障卡", price: 600,
          sellerName: "测试卖家", ruleName: "GPU 1", reason: "标题明确说明花屏，不符合正常使用要求。",
          evidence: "花屏", reviewedAt: Date.now(), blocked: true, isBlocked: true,
          url: "https://www.goofish.com/item?id=fixture"
        },
        {
          itemId: "fixture-accessory", title: "显卡包装盒", price: 40,
          sellerName: "测试卖家", ruleName: "GPU 1", reason: "仅出售包装盒，不包含显卡。",
          evidence: "", reviewedAt: Date.now(), blocked: false, isBlocked: false,
          url: "https://www.goofish.com/item?id=fixture-accessory"
        },
        {
          itemId: "fixture-long", title: "<img src=x onerror=alert(1)>", price: 300,
          sellerName: "测试", ruleName: "GPU", reason: "VeryLongReason".repeat(30),
          evidence: "<script>unsafe()</script>", reviewedAt: Date.now(), blocked: true, isBlocked: false,
          url: "https://www.goofish.com/item?id=fixture-long"
        }
      ]
    };
    const files = { "/": "index.html", "/app.js": "app.js", "/styles.css": "styles.css" };
    let restarts = 0;
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === "http://monitor.test" && url.pathname === "/api/browser/restart-login"
        && route.request().method() === "POST") {
        restarts += 1;
        Object.assign(status, {
          accessPaused: true, recoveryState: "checking",
          lastActivity: "已打开登录窗口；请在窗口中完成登录或验证，程序会自动继续查询。"
        });
        return route.fulfill({ json: status });
      }
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
    assert.equal(await page.locator("#browser-name").innerText(), "Microsoft Edge");
    assert.match(await page.locator("#rotation-estimate").innerText(), /按顺序查询 5 条/);
    assert.equal(
      await page.locator('[data-action="scan"]:disabled').count(),
      accessPaused ? 5 : 0
    );
    assert.equal(await page.locator("#start-monitor").isDisabled(), running);
    assert.equal(await page.locator("#stop-monitor").isDisabled(), !running);
    assert.equal(await page.locator("#resume-monitor").isDisabled(), !accessPaused);
    assert.equal(await page.locator("#restart-login").isDisabled(), false);
    assert.equal(await page.locator("#ai-enabled").isChecked(), false);
    assert.equal(await page.locator("#ai-review-state").innerText(), "未启用");
    assert.match(await page.locator("#ai-rejections-body").innerText(), /标题明确说明花屏/);
    assert.match(await page.locator("#ai-rejections-body").innerText(), /原文依据：花屏/);
    assert.match(await page.locator("#ai-rejections-body").innerText(), /仅过滤提醒/);
    assert.match(await page.locator("#ai-rejections-body").innerText(), /已解除屏蔽/);
    assert.equal(await page.locator('#ai-rejections-body button[data-action="restore-ai"]').count(), 3);
    assert.equal(await page.locator("#ai-rejections-body img, #ai-rejections-body script").count(), 0);
    assert.match(
      await page.locator("#search-schedule").innerText(),
      accessPaused ? /已暂停/ : running ? /随机 45–75 秒/ : /未启动/
    );
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false);
    assert.deepEqual(errors, []);
    const directory = resolve("work", "schedule-ui");
    mkdirSync(directory, { recursive: true });
    await page.screenshot({ path: resolve(directory, `${name}.png`), fullPage: true });
    await page.locator("#ai-rejections").screenshot({ path: resolve(directory, `${name}-ai-reasons.png`) });
    if (width < 760) {
      const firstReason = await page.locator(".ai-reason").first().boundingBox();
      assert.ok(firstReason.x >= 0 && firstReason.x + firstReason.width <= width);
      assert.equal(await page.locator("#ai-rejections .table-wrap").evaluate((element) =>
        element.scrollWidth > element.clientWidth), false);
    }
    assert.match(await page.locator("#search-frequency").innerText(), /随机等待 45–75 秒/);
    await page.locator("#restart-login").click();
    await page.waitForFunction(() => document.querySelector("#access-recovery").textContent.includes("完成登录"));
    assert.equal(restarts, 1);
    assert.equal(await page.locator("#restart-login").isEnabled(), true);
  });
}
