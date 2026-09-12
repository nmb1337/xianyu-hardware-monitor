import test from "node:test";
import assert from "node:assert/strict";
import { MonitorDatabase } from "../src/db.js";
import { MonitorService } from "../src/monitor.js";
import { setImmediate } from "node:timers/promises";
import { GLOBAL_SEARCH_INTERVAL_MIN_MS, GLOBAL_SEARCH_SLOT_GRACE_MS } from "../src/pacing.js";

function testClock(t) {
  let timestamp = Date.now();
  t.mock.method(Date, "now", () => timestamp);
  return {
    nextSlot(monitor) { timestamp = monitor.status().nextSearchAt; },
    advance(milliseconds) { timestamp += milliseconds; }
  };
}

test("monitor baselines existing results then alerts only a new low-price result", async (t) => {
  const clock = testClock(t);
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

  clock.nextSlot(monitor);
  const first = await monitor.scanRule(rule, { force: true });
  assert.equal(first.baseline, true);
  assert.equal(first.queued, 0);

  clock.nextSlot(monitor);
  const second = await monitor.scanRule(database.getRule(rule.id), { force: true });
  assert.equal(second.baseline, false);
  assert.equal(second.queued, 1);
  assert.equal(second.alreadySeen, 1);
  assert.equal(database.listNotifications().length, 1);

  database.close();
});

test("verification pauses all automatic searches for a cooldown period", async (t) => {
  const clock = testClock(t);
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

  clock.nextSlot(monitor);
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

test("login expiry pauses searches until a human confirms login", async (t) => {
  const clock = testClock(t);
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

  clock.nextSlot(monitor);
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

function accessFixture(t, overrides = {}) {
  const clock = testClock(t);
  const database = new MonitorDatabase(":memory:");
  t.after(() => database.close());
  const rule = database.createRule({
    name: "GPU", category: "gpu", keyword: "GPU", priceCeilingCny: 1000,
    enabled: true, scanIntervalSeconds: 300
  });
  const browser = {
    status: () => ({ state: "waiting_for_verification" }),
    scan: async () => { throw new Error("verification required"); },
    verifyLogin: async () => ({ state: "verified" }),
    ...overrides
  };
  const notifier = { configured: () => false, processOne: async () => false };
  const monitor = new MonitorService({ database, browser, notifier });
  clock.nextSlot(monitor);
  return { database, browser, notifier, monitor, rule, clock };
}

test("concurrent manual scans recheck the pause after the first scan fails", async (t) => {
  let scans = 0;
  const { monitor, rule } = accessFixture(t, {
    scan: async () => {
      scans += 1;
      await setImmediate();
      throw new Error("verification required");
    }
  });
  const results = await Promise.allSettled([
    monitor.scanRule(rule, { force: true }),
    monitor.scanRule(rule, { force: true })
  ]);
  assert.equal(scans, 1);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[1].value.scanned, false);
});

test("the pause is persisted before waiting for the QQ notification", async (t) => {
  const { monitor, rule, database, notifier } = accessFixture(t);
  let release;
  const sending = new Promise((resolve) => { release = resolve; });
  notifier.configured = () => true;
  notifier.sendMessage = () => sending;
  const scan = assert.rejects(monitor.scanRule(rule, { force: true }));
  await setImmediate();
  const paused = database.getSetting("xianyu_access_paused");
  release();
  await scan;
  assert.equal(paused, "1");
});

test("manual confirmation cannot skip the verification cooldown", async (t) => {
  const { monitor, rule } = accessFixture(t);
  await assert.rejects(monitor.scanRule(rule, { force: true }));
  await assert.rejects(monitor.resumeAfterHumanCheck(), /冷却/);
  assert.equal(monitor.status().accessPaused, true);
});

test("expired persisted pause never auto resumes, even with a verified cookie state", async (t) => {
  let checks = 0;
  const { database, browser, notifier } = accessFixture(t, {
    verifyLogin: async () => {
      checks += 1;
      return { state: "verified" };
    }
  });
  database.setSetting("xianyu_access_paused", "1");
  database.setSetting("xianyu_access_pause_until", String(Date.now() - 1000));
  database.setSetting("xianyu_access_pause_kind", "verification");
  const restarted = new MonitorService({ database, browser, notifier });
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  restarted.start();
  await setImmediate();
  const stopping = restarted.stop();
  t.mock.timers.tick(15000);
  await stopping;
  assert.equal(checks, 0);
  assert.equal(restarted.status().accessPaused, true);
  await restarted.resumeAfterHumanCheck();
  assert.equal(restarted.status().accessPaused, false);
});

test("queued automatic scans use the current schedule after a manual scan", async (t) => {
  let scans = 0;
  const { monitor, rule } = accessFixture(t, {
    status: () => ({ state: "verified" }),
    scan: async () => {
      scans += 1;
      return [];
    }
  });
  const [manual, automatic] = await Promise.all([
    monitor.scanRule(rule, { force: true }),
    monitor.scanRule(rule)
  ]);
  assert.equal(manual.scanned, true);
  assert.equal(automatic.scanned, false);
  assert.equal(scans, 1);
});

test("AI can suppress a new rule match without affecting the baseline", async (t) => {
  const clock = testClock(t);
  const database = new MonitorDatabase(":memory:");
  t.after(() => database.close());
  const rule = database.createRule({
    name: "GPU", category: "gpu", keyword: "GPU", priceCeilingCny: 1000,
    enabled: true, scanIntervalSeconds: 300
  });
  const listing = {
    itemId: "ai-filtered", title: "GPU 显卡", price: 800,
    url: "https://www.goofish.com/item?id=ai-filtered", sellerName: "卖家", isPersonal: true
  };
  let round = 0;
  const browser = {
    status: () => ({ state: "verified" }),
    scan: async () => {
      round += 1;
      return round === 1 ? [] : [listing];
    }
  };
  const ai = {
    configured: () => true,
    reviewCandidates: async (_rule, candidates) => ({
      error: null,
      decisions: new Map([[candidates[0].itemId, { notify: false, reason: "疑似配件" }]])
    })
  };
  const notifier = { configured: () => false, processOne: async () => false };
  const monitor = new MonitorService({ database, browser, notifier, ai });
  clock.nextSlot(monitor);
  await monitor.scanRule(rule, { force: true });
  clock.nextSlot(monitor);
  const result = await monitor.scanRule(database.getRule(rule.id), { force: true });
  assert.equal(result.matched, 1);
  assert.equal(result.aiFiltered, 1);
  assert.equal(result.queued, 0);
  assert.equal(database.listNotifications().length, 0);
});

test("manual scans cannot bypass the persisted global low-frequency schedule", async (t) => {
  testClock(t);
  const database = new MonitorDatabase(":memory:");
  t.after(() => database.close());
  const rule = database.createRule({
    name: "GPU", category: "gpu", keyword: "GPU", priceCeilingCny: 1000,
    enabled: true, scanIntervalSeconds: 300
  });
  let scans = 0;
  const browser = {
    status: () => ({ state: "verified" }),
    scan: async () => {
      scans += 1;
      return [];
    }
  };
  const notifier = { configured: () => false, processOne: async () => false };
  const monitor = new MonitorService({ database, browser, notifier, random: () => 0 });

  const result = await monitor.scanNow(rule.id);
  assert.equal(result.scanned, false);
  assert.match(result.reason, /全局低频保护/);
  assert.equal(scans, 0);
  assert.equal(
    Number(database.getSetting("xianyu_global_search_next_at")),
    monitor.status().nextSearchAt
  );
});

test("a search reserves the next global slot before a failed browser request", async (t) => {
  const clock = testClock(t);
  const database = new MonitorDatabase(":memory:");
  t.after(() => database.close());
  const rule = database.createRule({
    name: "GPU", category: "gpu", keyword: "GPU", priceCeilingCny: 1000,
    enabled: true, scanIntervalSeconds: 300
  });
  let scans = 0;
  const browser = {
    status: () => ({ state: "verified" }),
    scan: async () => {
      scans += 1;
      assert.equal(
        Number(database.getSetting("xianyu_global_search_next_at")),
        Date.now() + GLOBAL_SEARCH_INTERVAL_MIN_MS
      );
      throw new Error("temporary browser failure");
    }
  };
  const notifier = { configured: () => false, processOne: async () => false };
  const monitor = new MonitorService({ database, browser, notifier, random: () => 0 });
  clock.nextSlot(monitor);

  await assert.rejects(() => monitor.scanNow(rule.id), /temporary browser failure/);
  const nextSearchAt = Number(database.getSetting("xianyu_global_search_next_at"));
  assert.ok(nextSearchAt >= Date.now() + (90 * 60_000) - 1_000);
  const retry = await monitor.scanNow(rule.id);
  assert.equal(retry.scanned, false);
  assert.equal(scans, 1);
});

test("only one rule can use a global search slot", async (t) => {
  const clock = testClock(t);
  const database = new MonitorDatabase(":memory:");
  t.after(() => database.close());
  const first = database.createRule({
    name: "GPU", category: "gpu", keyword: "GPU", priceCeilingCny: 1000,
    enabled: true, scanIntervalSeconds: 300
  });
  const second = database.createRule({
    name: "CPU", category: "cpu", keyword: "CPU", priceCeilingCny: 1000,
    enabled: true, scanIntervalSeconds: 300
  });
  const scannedIds = [];
  const browser = {
    status: () => ({ state: "verified" }),
    scan: async (rule) => {
      scannedIds.push(rule.id);
      return [];
    }
  };
  const notifier = { configured: () => false, processOne: async () => false };
  const monitor = new MonitorService({ database, browser, notifier, random: () => 0 });
  clock.nextSlot(monitor);

  const [firstResult, secondResult] = await Promise.all([
    monitor.scanNow(first.id),
    monitor.scanNow(second.id)
  ]);
  assert.equal(firstResult.scanned, true);
  assert.equal(secondResult.scanned, false);
  assert.deepEqual(scannedIds, [first.id]);
});

function scheduleFixture(t, { failFirst = false } = {}) {
  const clock = testClock(t);
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const database = new MonitorDatabase(":memory:");
  const rules = Array.from({ length: 3 }, (_, index) => database.createRule({
    name: `GPU ${index}`, category: "gpu", keyword: `GPU ${index}`, priceCeilingCny: 1000,
    enabled: true, scanIntervalSeconds: 300
  }));
  const scannedIds = [];
  const browser = {
    status: () => ({ state: "verified" }),
    verifyLogin: async () => ({ state: "verified" }),
    scan: async (rule) => {
      scannedIds.push(rule.id);
      if (failFirst && scannedIds.length === 1) {
        throw new Error("temporary failure");
      }
      return [];
    }
  };
  const notifier = { configured: () => false, processOne: async () => false };
  const dependencies = { database, browser, notifier, random: () => 0 };
  const monitor = new MonitorService(dependencies);
  t.after(async () => {
    await monitor.stop();
    database.close();
  });
  const poll = async () => {
    t.mock.timers.tick(15_000);
    await setImmediate();
  };
  return { clock, database, rules, browser, scannedIds, dependencies, monitor, poll };
}

test("starting waits for the first slot and stop wakes the sleeping loop immediately", async (t) => {
  const { monitor, poll, scannedIds } = scheduleFixture(t);
  const deadline = monitor.status().nextSearchAt;
  monitor.start();
  await poll();
  assert.deepEqual(scannedIds, []);
  await monitor.stop();
  assert.equal(monitor.status().running, false);
  assert.equal(monitor.status().nextSearchAt, deadline);
});

test("automatic scanning rotates due rules fairly, including a failed rule", async (t) => {
  const { monitor, clock, poll, rules, database, scannedIds } = scheduleFixture(t, { failFirst: true });
  monitor.start();
  for (let index = 0; index < 6; index += 1) {
    clock.nextSlot(monitor);
    await poll();
    assert.equal(scannedIds.length, index + 1);
    assert.equal(scannedIds[index], rules[index % rules.length].id);
    if (index === 0) {
      assert.equal(database.getRule(rules[0].id).lastScannedAt, null);
    }
    await poll();
    assert.equal(scannedIds.length, index + 1);
  }
});

test("restart and stop-start preserve a future deadline and defer an expired one", async (t) => {
  const { monitor, dependencies, clock, scannedIds } = scheduleFixture(t);
  monitor.start();
  await monitor.stop();
  const deadline = monitor.status().nextSearchAt;
  clock.advance(60_000);
  monitor.start();
  assert.equal(monitor.status().nextSearchAt, deadline);
  await monitor.stop();
  const restarted = new MonitorService(dependencies);
  assert.equal(restarted.status().nextSearchAt, deadline);
  assert.equal((await restarted.scanNow(1)).scanned, false);
  clock.nextSlot(restarted);
  clock.advance(60_000);
  const expiredRestart = new MonitorService(dependencies);
  assert.equal(expiredRestart.status().nextSearchAt, Date.now() + GLOBAL_SEARCH_INTERVAL_MIN_MS);
  assert.equal((await expiredRestart.scanNow(1)).scanned, false);
  assert.deepEqual(scannedIds, []);
});

test("sleeping past a slot reschedules without catch-up requests, including manual scans", async (t) => {
  const { monitor, clock, poll, rules, scannedIds } = scheduleFixture(t);
  monitor.start();
  clock.nextSlot(monitor);
  clock.advance(GLOBAL_SEARCH_SLOT_GRACE_MS + 1);
  assert.equal((await monitor.scanNow(rules[0].id)).scanned, false);
  await poll();
  assert.deepEqual(scannedIds, []);
  assert.equal(monitor.status().nextSearchAt, Date.now() + GLOBAL_SEARCH_INTERVAL_MIN_MS);
  clock.nextSlot(monitor);
  clock.advance(24 * 60 * 60_000);
  await poll();
  assert.deepEqual(scannedIds, []);
  clock.nextSlot(monitor);
  await poll();
  assert.equal(scannedIds.length, 1);
  await poll();
  assert.equal(scannedIds.length, 1);
});

test("a long scan leaves a full global gap after it finishes", async (t) => {
  const { monitor, clock, browser, rules } = scheduleFixture(t);
  browser.scan = async () => {
    clock.advance(3 * 60 * 60_000);
    return [];
  };
  clock.nextSlot(monitor);
  assert.equal((await monitor.scanNow(rules[0].id)).scanned, true);
  assert.equal(monitor.status().nextSearchAt, Date.now() + GLOBAL_SEARCH_INTERVAL_MIN_MS);
  assert.equal((await monitor.scanNow(rules[1].id)).scanned, false);
});

test("rule creation and editing never shorten the global deadline", async (t) => {
  const { monitor, database, rules, scannedIds } = scheduleFixture(t);
  const deadline = monitor.status().nextSearchAt;
  const edited = database.updateRule(rules[0].id, { keyword: "GPU changed" });
  const added = database.createRule({
    ...rules[0], name: "New GPU", keyword: "New GPU"
  });
  assert.equal((await monitor.scanNow(edited.id)).scanned, false);
  assert.equal((await monitor.scanNow(added.id)).scanned, false);
  assert.equal(monitor.status().nextSearchAt, deadline);
  assert.deepEqual(scannedIds, []);
});

test("manual verification recovery preserves a future slot and replaces an expired slot", async (t) => {
  const { monitor, rule, clock } = accessFixture(t);
  await assert.rejects(monitor.scanNow(rule.id));
  const deadline = monitor.status().nextSearchAt;
  clock.advance(31 * 60_000);
  await monitor.resumeAfterHumanCheck();
  assert.equal(monitor.status().nextSearchAt, deadline);
  assert.equal((await monitor.scanNow(rule.id)).scanned, false);
  clock.nextSlot(monitor);
  await assert.rejects(monitor.scanNow(rule.id));
  clock.nextSlot(monitor);
  clock.advance(60_000);
  await monitor.resumeAfterHumanCheck();
  assert.ok(monitor.status().nextSearchAt >= Date.now() + GLOBAL_SEARCH_INTERVAL_MIN_MS);
  assert.equal(monitor.status().running, false);
  assert.equal((await monitor.scanNow(rule.id)).scanned, false);
});
