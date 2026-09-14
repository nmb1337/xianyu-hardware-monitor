import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { MonitorDatabase } from "../src/db.js";
import { MonitorService } from "../src/monitor.js";

function fixture(t, { canSwitch = true } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const database = new MonitorDatabase(":memory:");
  const rules = [
    database.createRule({ name: "GPU", category: "gpu", keyword: "GPU", priceCeilingCny: 1000, enabled: true }),
    database.createRule({ name: "CPU", category: "cpu", keyword: "CPU", priceCeilingCny: 1000, enabled: true })
  ];
  let state = "verified";
  let browserOpen = true;
  let cachedLogin = true;
  let blockKind = "waiting_for_verification";
  let failCount = 0;
  const calls = { close: 0, open: 0, switch: 0, verify: 0, scan: 0, order: [], messages: [] };
  const browser = {
    status: () => ({
      state,
      browserOpen,
      available: true,
      canSwitch,
      alternateBrowserName: "Google Chrome",
      browserName: "Microsoft Edge"
    }),
    close: async () => {
      calls.close += 1;
      calls.order.push("close");
      browserOpen = false;
      state = "not_started";
    },
    openLogin: async () => {
      calls.open += 1;
      calls.order.push("open");
      browserOpen = true;
      state = cachedLogin ? "verified" : "waiting_for_login";
      return browser.status();
    },
    switchBrowser: async () => {
      calls.switch += 1;
      calls.order.push("switch");
      browserOpen = false;
      state = "not_started";
      return browser.status();
    },
    verifyLogin: async () => {
      calls.verify += 1;
      calls.order.push("verify");
      return browser.status();
    },
    scan: async () => {
      calls.scan += 1;
      calls.order.push("scan");
      if (failCount > 0) {
        failCount -= 1;
        state = blockKind;
        throw new Error(blockKind === "waiting_for_login" ? "login required" : "verification required");
      }
      return [];
    }
  };
  const notifier = {
    configured: () => true,
    processOne: async () => false,
    sendMessage: async (message) => calls.messages.push(message)
  };
  const monitor = new MonitorService({ database, browser, notifier });
  t.after(async () => {
    await monitor.stop();
    database.close();
  });
  return {
    database, browser, monitor, rules, calls,
    failScans(count, kind = "waiting_for_verification") {
      failCount = count;
      blockKind = kind;
    },
    login() {
      state = "verified";
    },
    logoutCache() {
      cachedLogin = false;
    },
    makeCachedLoginWork() {
      cachedLogin = true;
    },
    userCloses() {
      browserOpen = false;
      state = "not_started";
    },
    async poll(count = 1) {
      for (let index = 0; index < count; index += 1) {
        t.mock.timers.tick(15_000);
        await setImmediate();
        await setImmediate();
      }
    }
  };
}

test("a verification block switches browsers, confirms the cached login, and resumes scanning", async (t) => {
  const f = fixture(t);
  f.failScans(1);
  f.monitor.start();
  await f.poll(4);

  assert.equal(f.monitor.status().accessPaused, false);
  assert.equal(f.calls.switch, 1);
  assert.equal(f.calls.open, 1);
  assert.ok(f.calls.scan >= 2, `expected the rotation to continue, saw ${f.calls.scan} scans`);
  assert.deepEqual(f.calls.order.slice(0, 6), ["scan", "close", "switch", "open", "verify", "scan"]);
  assert.match(f.calls.messages[0], /自动切换到 Google Chrome/);
  assert.match(f.calls.messages[1], /登录已恢复/);
  assert.match(f.calls.messages[2], /恢复后首次扫描完成/);
});

test("a login that completes later inside the opened window resumes automatically", async (t) => {
  const f = fixture(t);
  f.logoutCache();
  f.failScans(1);
  f.monitor.start();
  await f.poll(3);

  assert.equal(f.monitor.status().accessPaused, true);
  assert.equal(f.monitor.status().recoveryState, "checking");
  assert.equal(f.calls.switch, 1);
  assert.equal(f.calls.open, 1);
  const scansBefore = f.calls.scan;

  f.login();
  await f.poll(2);
  assert.equal(f.monitor.status().accessPaused, false);
  assert.ok(f.calls.scan > scansBefore);
  assert.ok(f.calls.messages.some((message) => /登录已恢复/.test(message)));
});

test("closing the recovery window stops automatic reopening until the user asks again", async (t) => {
  const f = fixture(t);
  f.logoutCache();
  f.failScans(1);
  f.monitor.start();
  await f.poll(3);
  assert.equal(f.calls.open, 1);

  f.userCloses();
  await f.poll(3);
  assert.equal(f.monitor.status().recoveryState, "closed_by_user");
  assert.equal(f.monitor.status().accessPaused, true);
  assert.equal(f.calls.open, 1);

  f.makeCachedLoginWork();
  await f.monitor.openLogin();
  assert.equal(f.calls.open, 2);
  assert.equal(f.monitor.status().accessPaused, false);
});

test("two automatic recoveries without a successful scan stop the window switching", async (t) => {
  const f = fixture(t);
  f.failScans(99);
  f.monitor.start();
  await f.poll(8);

  assert.equal(f.monitor.status().accessPaused, true);
  assert.equal(f.calls.switch, 2);
  assert.equal(f.monitor.status().recoveryState, "manual");
  const opened = f.calls.open;
  await f.poll(4);
  assert.equal(f.calls.open, opened);
  assert.ok(f.calls.messages.some((message) => /停止自动切换/.test(message)));
});

test("login expiry uses the same automatic switch and confirmation flow", async (t) => {
  const f = fixture(t);
  f.failScans(1, "waiting_for_login");
  f.monitor.start();
  await f.poll(4);

  assert.equal(f.monitor.status().accessPaused, false);
  assert.equal(f.monitor.status().accessPauseKind, "");
  assert.equal(f.calls.switch, 1);
  assert.equal(f.calls.open, 1);
  assert.match(f.calls.messages[0], /登录已失效/);
});

test("manual restart-login opens the current browser and recovers without any cooldown", async (t) => {
  const f = fixture(t);
  f.failScans(1);
  await assert.rejects(f.monitor.scanRule(f.rules[0], { force: true }));
  assert.equal(f.monitor.status().accessPaused, true);

  await f.monitor.restartLogin();
  assert.equal(f.calls.switch, 0);
  assert.equal(f.calls.open, 1);
  assert.equal(f.calls.verify, 1);
  assert.equal(f.monitor.status().accessPaused, false);
});

test("a failed automatic window open is reported once and can be retried manually", async (t) => {
  const f = fixture(t);
  const open = f.browser.openLogin;
  f.browser.openLogin = async () => {
    throw new Error("launch failed");
  };
  f.failScans(1);
  f.monitor.start();
  await f.poll(3);

  assert.equal(f.monitor.status().recoveryState, "open_failed");
  await f.poll(2);
  assert.equal(f.monitor.status().recoveryState, "open_failed");
  assert.equal(f.monitor.status().accessPaused, true);

  f.browser.openLogin = open;
  await f.monitor.restartLogin();
  assert.equal(f.monitor.status().accessPaused, false);
});

test("a single-browser setup reopens the same browser and stops after repeated failures", async (t) => {
  const f = fixture(t, { canSwitch: false });
  f.failScans(99);
  f.monitor.start();
  await f.poll(8);

  assert.equal(f.calls.switch, 0);
  assert.equal(f.calls.open, 2);
  assert.equal(f.monitor.status().recoveryState, "manual");
  assert.equal(f.monitor.status().accessPaused, true);
});
