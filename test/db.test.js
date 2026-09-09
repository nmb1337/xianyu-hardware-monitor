import test from "node:test";
import assert from "node:assert/strict";
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
