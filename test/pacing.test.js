import test from "node:test";
import assert from "node:assert/strict";
import {
  MINIMUM_RULE_INTERVAL_SECONDS,
  MINIMUM_SEARCH_GAP_MS,
  GLOBAL_SEARCH_INTERVAL_MIN_MS,
  GLOBAL_SEARCH_INTERVAL_MAX_MS,
  QUIET_HOURS_START,
  QUIET_HOURS_END,
  VERIFICATION_COOLDOWN_MS,
  MAX_VERIFICATION_COOLDOWN_MS,
  nextAccessCooldownMs,
  nextGlobalSearchDelayMs,
  isQuietHours
} from "../src/pacing.js";

test("access cooldown doubles and caps at two hours", () => {
  assert.equal(MINIMUM_RULE_INTERVAL_SECONDS, 300);
  assert.equal(MINIMUM_SEARCH_GAP_MS, 90_000);
  assert.equal(nextAccessCooldownMs(1), VERIFICATION_COOLDOWN_MS);
  assert.equal(nextAccessCooldownMs(2), 60 * 60_000);
  assert.equal(nextAccessCooldownMs(3), MAX_VERIFICATION_COOLDOWN_MS);
  assert.equal(nextAccessCooldownMs(8), MAX_VERIFICATION_COOLDOWN_MS);
});

test("global searches are randomly scheduled between 90 and 120 minutes", () => {
  assert.equal(GLOBAL_SEARCH_INTERVAL_MIN_MS, 90 * 60_000);
  assert.equal(GLOBAL_SEARCH_INTERVAL_MAX_MS, 120 * 60_000);
  assert.equal(nextGlobalSearchDelayMs(() => 0), GLOBAL_SEARCH_INTERVAL_MIN_MS);
  assert.equal(nextGlobalSearchDelayMs(() => 1), GLOBAL_SEARCH_INTERVAL_MAX_MS);
  assert.equal(nextGlobalSearchDelayMs(() => 0.5), 105 * 60_000);
});

test("quiet hours disable searches from midnight through 08:00 China time", () => {
  assert.equal(QUIET_HOURS_START, 0);
  assert.equal(QUIET_HOURS_END, 8);
  assert.equal(isQuietHours(Date.UTC(2026, 8, 12, 16, 0)), true);
  assert.equal(isQuietHours(Date.UTC(2026, 8, 12, 23, 59)), true);
  assert.equal(isQuietHours(Date.UTC(2026, 8, 13, 0, 0)), false);
});
