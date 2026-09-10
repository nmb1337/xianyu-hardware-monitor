import test from "node:test";
import assert from "node:assert/strict";
import { MonitorDatabase } from "../src/db.js";
import { MonitorService } from "../src/monitor.js";

test("monitor baselines existing results then alerts only a new low-price result", async () => {
  const database = new MonitorDatabase(":memory:");
  const rule = database.createRule({
    name: "CPU 监控",
    category: "cpu",
    keyword: "7800X3D CPU",
    includeTerms: ["7800X3D"],
    excludeTerms: ["坏"],
    priceCeilingCny: 2200,
    personalOnly: true,
    enabled: true,
    scanIntervalSeconds: 120
  });

  const oldListing = {
    itemId: "old-cpu",
    title: "个人 7800X3D CPU",
    price: 2000,
    url: "https://www.goofish.com/item?id=old-cpu",
    sellerName: "旧商品",
    isPersonal: true
  };
  const newListing = {
    itemId: "new-cpu",
    title: "个人 7800X3D CPU",
    price: 1900,
    url: "https://www.goofish.com/item?id=new-cpu",
    sellerName: "新商品",
    isPersonal: true
  };
  let scanCount = 0;
  const browser = {
    status: () => ({ state: "verified" }),
    scan: async () => {
      scanCount += 1;
      return scanCount === 1 ? [oldListing] : [oldListing, newListing];
    }
  };
  const notifier = {
    configured: () => false,
    processOne: async () => false
  };
  const monitor = new MonitorService({ database, browser, notifier });

  const first = await monitor.scanRule(rule, { force: true });
  assert.equal(first.baseline, true);
  assert.equal(first.queued, 0);

  const second = await monitor.scanRule(database.getRule(rule.id), { force: true });
  assert.equal(second.baseline, false);
  assert.equal(second.queued, 1);
  assert.equal(second.alreadySeen, 1);
  assert.equal(database.listNotifications().length, 1);

  database.close();
});

test("verification pauses all automatic searches for a cooldown period", async () => {
  const database = new MonitorDatabase(":memory:");
  const rule = database.createRule({
    name: "GPU 监控",
    category: "gpu",
    keyword: "RTX 3070",
    includeTerms: [],
    excludeTerms: [],
    priceCeilingCny: 1400,
    personalOnly: true,
    enabled: true,
    scanIntervalSeconds: 300
  });
  let calls = 0;
  const messages = [];
  const browser = {
    status: () => ({ state: "waiting_for_verification" }),
    scan: async () => {
      calls += 1;
      throw new Error("闲鱼弹出了访问验证");
    }
  };
  const notifier = {
    configured: () => true,
    processOne: async () => false,
    sendMessage: async (message) => {
      messages.push(message);
    }
  };
  const monitor = new MonitorService({ database, browser, notifier });

  await assert.rejects(() => monitor.scanRule(rule, { force: true }));
  assert.equal(database.getSetting("xianyu_access_paused"), "1");
  assert.ok(Number(database.getSetting("xianyu_access_pause_until")) > Date.now());
  assert.equal(messages.length, 1);
  assert.match(messages[0], /访问验证/);
  assert.equal(database.getRule(rule.id).lastScannedAt, null);

  const paused = await monitor.scanRule(database.getRule(rule.id), { force: true });
  assert.equal(paused.scanned, false);
  assert.equal(calls, 1);

  database.close();
});

test("login expiry pauses searches until a human confirms login", async () => {
  const database = new MonitorDatabase(":memory:");
  const first = database.createRule({
    name: "GPU 监控",
    category: "gpu",
    keyword: "RTX 3070",
    includeTerms: [],
    excludeTerms: [],
    priceCeilingCny: 1400,
    personalOnly: true,
    enabled: true,
    scanIntervalSeconds: 300
  });
  database.createRule({
    name: "CPU 监控",
    category: "cpu",
    keyword: "7800X3D",
    includeTerms: [],
    excludeTerms: [],
    priceCeilingCny: 2200,
    personalOnly: true,
    enabled: true,
    scanIntervalSeconds: 300
  });
  let state = "waiting_for_login";
  const browser = {
    status: () => ({ state }),
    scan: async () => {
      throw new Error("需要在浏览器中登录闲鱼后才能扫描。");
    },
    verifyLogin: async () => ({ state, message: state === "verified" ? "闲鱼登录状态已验证。" : "未检测到有效登录状态" })
  };
  const notifier = {
    configured: () => false,
    processOne: async () => false
  };
  const monitor = new MonitorService({ database, browser, notifier });

  await assert.rejects(() => monitor.scanRule(first, { force: true }));
  assert.equal(database.getSetting("xianyu_access_pause_kind"), "login");

  await assert.rejects(() => monitor.resumeAfterHumanCheck());
  assert.equal(monitor.status().accessPaused, true);

  state = "verified";
  const status = await monitor.resumeAfterHumanCheck();
  assert.equal(status.accessPaused, false);
  const nextTimes = database.listRules().map((rule) => rule.nextScanAt).sort((a, b) => a - b);
  assert.ok(nextTimes[0] > Date.now());
  assert.ok(nextTimes[0] < Date.now() + 120_000);
  assert.ok(nextTimes[1] - nextTimes[0] >= 90_000);

  database.close();
});
