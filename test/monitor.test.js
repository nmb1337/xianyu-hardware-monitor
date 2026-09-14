import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { MonitorDatabase } from "../src/db.js";
import { MonitorService } from "../src/monitor.js";
import { AiReviewer } from "../src/ai.js";

function makeRule(database, overrides = {}) {
  return database.createRule({
    name: "GPU",
    category: "gpu",
    keyword: "GPU",
    priceCeilingCny: 1000,
    enabled: true,
    ...overrides
  });
}

function makeIdleNotifier() {
  return { configured: () => false, processOne: async () => false };
}

test("monitor baselines existing results then alerts only a new low-price result", async (t) => {
  const database = new MonitorDatabase(":memory:");
  t.after(() => database.close());
  const rule = database.createRule({
    name: "CPU 监控",
    category: "cpu",
    keyword: "7800X3D CPU",
    includeTerms: ["7800X3D"],
    excludeTerms: ["坏"],
    priceCeilingCny: 2200,
    personalOnly: true,
    enabled: true
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
  const monitor = new MonitorService({ database, browser, notifier: makeIdleNotifier() });

  const first = await monitor.scanRule(rule, { force: true });
  assert.equal(first.baseline, true);
  assert.equal(first.queued, 0);

  const second = await monitor.scanRule(database.getRule(rule.id), { force: true });
  assert.equal(second.baseline, false);
  assert.equal(second.queued, 1);
  assert.equal(second.alreadySeen, 1);
  assert.equal(database.listNotifications().length, 1);
});

test("automatic scanning walks enabled rules in creation order and keeps rotating", async (t) => {
  const database = new MonitorDatabase(":memory:");
  const rules = Array.from({ length: 3 }, (_, index) => makeRule(database, {
    name: `GPU ${index}`,
    keyword: `GPU ${index}`
  }));
  const scanned = [];
  const browser = {
    status: () => ({ state: "verified" }),
    scan: async (rule) => {
      scanned.push(rule.id);
      await setImmediate();
      return [];
    }
  };
  const monitor = new MonitorService({ database, browser, notifier: makeIdleNotifier() });
  t.after(async () => {
    await monitor.stop();
    database.close();
  });

  monitor.start();
  for (let index = 0; index < 50 && scanned.length < 6; index += 1) {
    await setImmediate();
  }
  await monitor.stop();

  assert.ok(scanned.length >= 6, `expected at least 6 scans, saw ${scanned.length}`);
  assert.deepEqual(scanned.slice(0, 6), [
    rules[0].id, rules[1].id, rules[2].id,
    rules[0].id, rules[1].id, rules[2].id
  ]);
  assert.equal(monitor.status().enabledRuleCount, 3);
});

test("access verification pauses the rotation until the browser session recovers", async (t) => {
  const database = new MonitorDatabase(":memory:");
  t.after(() => database.close());
  const rule = makeRule(database);
  const messages = [];
  const browser = {
    status: () => ({ state: "waiting_for_verification" }),
    close: async () => {},
    scan: async () => {
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

  await assert.rejects(monitor.scanRule(rule, { force: true }));
  assert.equal(monitor.status().accessPaused, true);
  assert.equal(monitor.status().accessPauseKind, "verification");
  assert.equal(messages.length, 1);
  assert.match(messages[0], /访问验证/);

  const paused = await monitor.scanRule(database.getRule(rule.id), { force: true });
  assert.equal(paused.scanned, false);
  assert.match(paused.reason, /访问验证/);
});

test("the pause blocks further scans before the QQ notification settles", async (t) => {
  const database = new MonitorDatabase(":memory:");
  t.after(() => database.close());
  const rule = makeRule(database);
  let release;
  const sending = new Promise((resolve) => { release = resolve; });
  const browser = {
    status: () => ({ state: "waiting_for_verification" }),
    close: async () => {},
    scan: async () => {
      throw new Error("verification required");
    }
  };
  const notifier = { configured: () => true, processOne: async () => false, sendMessage: () => sending };
  const monitor = new MonitorService({ database, browser, notifier });

  const scanning = assert.rejects(monitor.scanRule(rule, { force: true }));
  await setImmediate();
  assert.equal(monitor.status().accessPaused, true);
  release();
  await scanning;
});

test("concurrent manual scans recheck the pause after the first scan fails", async (t) => {
  const database = new MonitorDatabase(":memory:");
  t.after(() => database.close());
  const rule = makeRule(database);
  let scans = 0;
  const browser = {
    status: () => ({ state: "waiting_for_verification" }),
    close: async () => {},
    scan: async () => {
      scans += 1;
      await setImmediate();
      throw new Error("verification required");
    }
  };
  const monitor = new MonitorService({ database, browser, notifier: makeIdleNotifier() });

  const results = await Promise.allSettled([
    monitor.scanRule(rule, { force: true }),
    monitor.scanRule(rule, { force: true })
  ]);
  assert.equal(scans, 1);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[1].value.scanned, false);
});

test("stopping the monitor cancels a pending AI review without losing base-rule matches", async (t) => {
  const database = new MonitorDatabase(":memory:");
  t.after(() => database.close());
  database.updateSettings({ aiEnabled: true, aiBaseUrl: "https://relay.example/v1", aiModel: "fixture-model" });
  const rule = makeRule(database);
  database.markRuleScanned(rule.id);
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const ai = new AiReviewer(database, {
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      entered();
    })
  });
  const browser = {
    status: () => ({ state: "verified" }),
    scan: async () => [{ itemId: "new", title: "GPU", price: 600, url: "https://www.goofish.com/item?id=new" }]
  };
  const monitor = new MonitorService({ database, browser, notifier: makeIdleNotifier(), ai });

  const scanning = monitor.scanRule(database.getRule(rule.id), { force: true });
  await started;
  await monitor.stop();
  const result = await scanning;
  assert.equal(result.aiError, "AI 请求已取消");
  assert.equal(result.queued, 1);
  assert.equal(monitor.status().running, false);
  assert.equal(ai.pendingRequests.size, 0);
  assert.equal(database.listAiRejections().length, 0);
  assert.equal(database.listBlockedListings().length, 0);
});

test("AI can suppress a new rule match without affecting the baseline", async (t) => {
  const database = new MonitorDatabase(":memory:");
  t.after(() => database.close());
  const rule = makeRule(database);
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
  const monitor = new MonitorService({ database, browser, notifier: makeIdleNotifier(), ai });

  await monitor.scanRule(rule, { force: true });
  const result = await monitor.scanRule(database.getRule(rule.id), { force: true });
  assert.equal(result.matched, 1);
  assert.equal(result.aiFiltered, 1);
  assert.equal(result.queued, 0);
  assert.equal(database.listNotifications().length, 0);
  assert.equal(database.listAiRejections().length, 1);
  assert.equal(database.listAiRejections()[0].reason, "疑似配件");
  assert.equal(database.listAiRejections()[0].blocked, false);
});

test("AI-blocked listings retain their rejection reason and evidence without notifications", async (t) => {
  const database = new MonitorDatabase(":memory:");
  t.after(() => database.close());
  const rule = makeRule(database);
  const browser = {
    status: () => ({ state: "verified" }),
    scan: async () => []
  };
  const monitor = new MonitorService({ database, browser, notifier: makeIdleNotifier() });
  await monitor.scanNow(rule.id);

  const listing = {
    itemId: "faulty-gpu", title: "GPU faulty", price: 800,
    url: "https://www.goofish.com/item?id=faulty-gpu", sellerName: "Fixture"
  };
  browser.scan = async () => [listing];
  monitor.ai = {
    configured: () => true,
    reviewCandidates: async () => ({
      error: null,
      decisions: new Map([[listing.itemId, {
        notify: false, block: true, reason: "Faulty hardware", evidence: "faulty", confidence: 0.95
      }]])
    })
  };
  const result = await monitor.scanNow(rule.id);
  assert.equal(result.aiBlocked, 1);
  assert.equal(database.listNotifications().length, 0);
  assert.equal(database.listBlockedListings()[0].blockReason, "Faulty hardware");
  assert.equal(database.listAiRejections()[0].reason, "Faulty hardware");
  assert.equal(database.listAiRejections()[0].evidence, "faulty");
  assert.equal(database.listAiRejections()[0].isBlocked, true);
});

test("restoring an AI-blocked listing keeps alerts flowing and skips further AI reviews", async (t) => {
  const database = new MonitorDatabase(":memory:");
  t.after(() => database.close());
  const rule = makeRule(database);
  const browser = {
    status: () => ({ state: "verified" }),
    scan: async () => []
  };
  const monitor = new MonitorService({ database, browser, notifier: makeIdleNotifier() });
  await monitor.scanNow(rule.id);

  const listing = {
    itemId: "restored-gpu", title: "GPU 魔改卡", price: 800,
    url: "https://www.goofish.com/item?id=restored-gpu", sellerName: "卖家"
  };
  browser.scan = async () => [listing];
  const reviewed = [];
  monitor.ai = {
    configured: () => true,
    reviewCandidates: async (_rule, candidates) => {
      reviewed.push(...candidates.map((candidate) => candidate.itemId));
      return {
        error: null,
        decisions: new Map([[listing.itemId, {
          notify: false, block: true, reason: "标题写的是魔改卡", evidence: "魔改", confidence: 0.95
        }]])
      };
    }
  };

  const blockedScan = await monitor.scanNow(rule.id);
  assert.equal(blockedScan.aiBlocked, 1);
  assert.equal(database.isListingBlocked(listing.itemId), true);
  assert.equal(database.listNotifications().length, 0);

  // The user restores the listing from the blocked table.
  assert.equal(database.unblockListing(listing.itemId), true);
  assert.equal(database.isAiExempt(listing.itemId), true);

  const restoredScan = await monitor.scanNow(rule.id);
  assert.equal(restoredScan.aiBlocked, 0);
  assert.equal(restoredScan.queued, 1);
  assert.equal(database.isListingBlocked(listing.itemId), false);
  assert.deepEqual([...new Set(reviewed)], [listing.itemId]);
  assert.equal(database.listNotifications().length, 1);
});
