import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MonitorDatabase } from "../src/db.js";

function makeDatabase() {
  return new MonitorDatabase(":memory:");
}

function makeRule(database) {
  return database.createRule({
    name: "4070 监控",
    category: "gpu",
    keyword: "4070 显卡",
    includeTerms: ["4070"],
    excludeTerms: ["坏"],
    priceCeilingCny: 3500,
    personalOnly: true,
    enabled: true,
    scanIntervalSeconds: 120
  });
}

function makeListing(itemId, price) {
  return {
    itemId,
    title: `个人 RTX 4070 显卡 ${itemId}`,
    price,
    url: `https://www.goofish.com/item?id=${itemId}`,
    sellerName: "测试卖家",
    isPersonal: true
  };
}

test("new databases do not create customer service storage or expose its settings", (t) => {
  const database = makeDatabase();
  t.after(() => database.close());

  const tables = database.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  assert.equal(tables.some(({ name }) => name === "customer_messages"), false);
  assert.equal("recordCustomerMessage" in database, false);
  assert.equal("getCustomerConversation" in database, false);

  database.updateSettings({ aiCustomerEnabled: true, aiCustomerPrompt: "Obsolete instruction" });
  assert.equal(database.getSetting("ai_customer_enabled"), null);
  assert.equal(database.getSetting("ai_customer_prompt"), null);
  assert.equal("aiCustomerEnabled" in database.getPublicSettings(), false);
  assert.equal("aiCustomerPrompt" in database.getPublicSettings(), false);
});

test("AI rejection reasons persist after restart and reflect restored blocks", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "xianyu-review-test-"));
  const path = join(directory, "monitor.sqlite");
  let database = new MonitorDatabase(path);
  t.after(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const rule = makeRule(database);
  const listing = makeListing("ai-rejected", 2500);
  const decision = {
    notify: false, block: true, confidence: 0.95, evidence: "GPU faulty",
    reason: "The listing explicitly describes faulty hardware."
  };
  database.recordAiRejection(rule, listing, decision);
  database.recordAiRejection(rule, listing, decision);
  database.blockListing({ ...listing, blockReason: decision.reason });
  database.close();
  database = new MonitorDatabase(path);
  const [review] = database.listAiRejections();
  assert.equal(database.listAiRejections().length, 1);
  assert.equal(review.reason, decision.reason);
  assert.equal(review.evidence, decision.evidence);
  assert.equal(review.ruleName, rule.name);
  assert.equal(review.blocked, true);
  assert.equal(review.isBlocked, true);
  database.unblockListing(listing.itemId);
  assert.equal(database.listAiRejections()[0].isBlocked, false);
  assert.equal(database.listAiRejections()[0].reason, decision.reason);
  assert.equal(database.isAiExempt(listing.itemId), true);
  database.deleteRule(rule.id);
  assert.deepEqual(database.listAiRejections(), []);
});

test("restoring an AI rejection clears the record, block, and listing so it can alert again", (t) => {
  const database = makeDatabase();
  t.after(() => database.close());
  const rule = makeRule(database);
  const listing = makeListing("restore-review", 2500);
  database.recordAiRejection(rule, listing, { notify: false, block: true, reason: "Box only" });
  database.blockListing({ ...listing, blockReason: "Box only" });
  database.recordCandidateListing(rule, makeListing("restore-review", 2500), 2500, false, "suppressed");

  assert.equal(database.restoreAiRejectedItem(listing.itemId), true);
  assert.equal(database.restoreAiRejectedItem(listing.itemId), false);
  assert.deepEqual(database.listAiRejections(), []);
  assert.deepEqual(database.listBlockedListings(), []);
  assert.equal(database.hasListing(rule.id, listing.itemId), false);
  assert.equal(database.isAiExempt(listing.itemId), true);
});

test("AI rejections distinguish missing reasons from approved listings", (t) => {
  const database = makeDatabase();
  t.after(() => database.close());
  const rule = makeRule(database);
  database.recordAiRejection(rule, makeListing("approved", 2500), { notify: true });
  assert.deepEqual(database.listAiRejections(), []);
  database.recordAiRejection(rule, makeListing("filtered", 2500), { notify: false });
  const [review] = database.listAiRejections();
  assert.equal(review.reason, "AI 未提供具体理由");
  assert.equal(review.blocked, false);
  assert.equal(review.confidence, null);
  assert.equal(database.listNotifications().length, 0);
});

test("first scan stores baseline without creating a notification", () => {
  const database = makeDatabase();
  const rule = makeRule(database);

  const result = database.recordCandidateListing(
    rule,
    makeListing("old-item", 3200),
    3200,
    false,
    "baseline"
  );

  assert.equal(result.queued, false);
  assert.equal(database.listNotifications().length, 0);
  assert.equal(database.listListings().length, 0);
  database.close();
});

test("new below-ceiling item is queued once and duplicates are ignored", () => {
  const database = makeDatabase();
  const rule = makeRule(database);
  const listing = makeListing("new-item", 3200);

  assert.equal(
    database.recordCandidateListing(rule, listing, 3200, true, "low price").queued,
    true
  );
  assert.equal(
    database.recordCandidateListing(rule, listing, 3100, true, "low price again").queued,
    false
  );
  assert.equal(database.listNotifications().length, 1);
  assert.equal(database.listListings()[0].currentPrice, 3100);
  database.close();
});

test("high price baseline item remains hidden and does not alert after a later price drop", () => {
  const database = makeDatabase();
  const rule = makeRule(database);
  const listing = makeListing("tracked-item", 4000);

  assert.equal(
    database.recordCandidateListing(rule, listing, 4000, false, "baseline").queued,
    false
  );
  assert.equal(
    database.recordCandidateListing(rule, listing, 3000, true, "later drop").queued,
    false
  );
  assert.equal(database.listNotifications().length, 0);
  database.close();
});

test("blocked listing is hidden, cancels pending notifications, and can be restored", () => {
  const database = makeDatabase();
  const rule = makeRule(database);
  const listing = makeListing("blocked-item", 3200);

  assert.equal(
    database.recordCandidateListing(rule, listing, 3200, true, "low price").queued,
    true
  );
  assert.equal(database.listListings().length, 1);
  assert.equal(database.listNotifications()[0].status, "pending");

  database.blockListing(listing);
  assert.equal(database.isListingBlocked("blocked-item"), true);
  assert.equal(database.listListings().length, 0);
  assert.equal(database.listNotifications()[0].status, "blocked");
  assert.equal(database.claimNextNotification(), null);

  assert.equal(database.unblockListing("blocked-item"), true);
  assert.equal(database.isListingBlocked("blocked-item"), false);
  assert.equal(database.listListings().length, 1);
  assert.equal(database.listNotifications()[0].status, "pending");
  database.close();
});

test("enabled rules are returned in creation order for the sequential rotation", () => {
  const database = makeDatabase();
  const first = makeRule(database);
  const second = database.createRule({
    name: "CPU 监控",
    category: "cpu",
    keyword: "7800X3D",
    priceCeilingCny: 2200,
    personalOnly: true,
    enabled: true
  });
  const disabled = database.createRule({
    name: "SSD 监控",
    category: "ssd",
    keyword: "SSD",
    priceCeilingCny: 500,
    enabled: false
  });

  assert.deepEqual(
    database.enabledRulesInOrder().map((rule) => rule.id),
    [first.id, second.id]
  );
  database.updateRule(disabled.id, { enabled: true });
  assert.deepEqual(
    database.enabledRulesInOrder().map((rule) => rule.id),
    [first.id, second.id, disabled.id]
  );
  database.close();
});

test("markRuleScanned records the error without losing the last successful scan time", () => {
  const database = makeDatabase();
  const rule = makeRule(database);

  database.markRuleScanned(rule.id);
  const scannedAt = database.getRule(rule.id).lastScannedAt;
  assert.ok(scannedAt > 0);

  database.markRuleScanned(rule.id, { error: "temporary failure" });
  const failed = database.getRule(rule.id);
  assert.equal(failed.lastError, "temporary failure");
  assert.equal(failed.lastScannedAt, scannedAt);
  database.close();
});
