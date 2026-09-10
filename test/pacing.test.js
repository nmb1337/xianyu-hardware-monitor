import test from "node:test";
import assert from "node:assert/strict";
import {
  MINIMUM_RULE_INTERVAL_SECONDS,
  MINIMUM_SEARCH_GAP_MS,
  VERIFICATION_COOLDOWN_MS,
  MAX_VERIFICATION_COOLDOWN_MS,
  nextAccessCooldownMs
} from "../src/pacing.js";

test("access cooldown doubles and caps at two hours", () => {
  assert.equal(MINIMUM_RULE_INTERVAL_SECONDS, 300);
  assert.equal(MINIMUM_SEARCH_GAP_MS, 90_000);
  assert.equal(nextAccessCooldownMs(1), VERIFICATION_COOLDOWN_MS);
  assert.equal(nextAccessCooldownMs(2), 60 * 60_000);
  assert.equal(nextAccessCooldownMs(3), MAX_VERIFICATION_COOLDOWN_MS);
  assert.equal(nextAccessCooldownMs(8), MAX_VERIFICATION_COOLDOWN_MS);
});
