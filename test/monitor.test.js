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
