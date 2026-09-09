import test from "node:test";
import assert from "node:assert/strict";
import { evaluateListing, parsePrice, splitTerms } from "../src/filter.js";

test("parsePrice handles common Xianyu price text", () => {
  assert.equal(parsePrice("¥ 3,299"), 3299);
  assert.equal(parsePrice("￥899.50 元"), 899.5);
  assert.equal(parsePrice("面议"), null);
});

test("splitTerms accepts comma and newline separated terms", () => {
  assert.deepEqual(splitTerms("RTX 4070，国行\n在保,国行"), ["RTX 4070", "国行", "在保"]);
});

test("evaluateListing distinguishes eligible high price candidates from alerts", () => {
  const rule = {
    includeTerms: ["4070", "显卡"],
    excludeTerms: ["坏卡"],
    minPriceCny: 3000,
    maxPriceCny: 3500,
    personalOnly: true
  };

  assert.deepEqual(
    evaluateListing(rule, {
      title: "个人 RTX 4070 显卡",
      price: "3200 元",
      isPersonal: true
    }),
    { matched: true, eligible: true, reason: "符合规则", price: 3200 }
  );
  assert.equal(
    evaluateListing(rule, {
      title: "个人 RTX 4070 显卡",
      price: "4000 元",
      isPersonal: true
    }).eligible,
    true
  );
  assert.equal(
    evaluateListing(rule, {
      title: "个人 RTX 4070 显卡",
      price: "2600 元",
      isPersonal: true
    }).matched,
    false
  );
  assert.equal(
    evaluateListing(rule, {
      title: "个人 RTX 4070 坏卡",
      price: "1000 元",
      isPersonal: true
    }).eligible,
    false
  );
});
