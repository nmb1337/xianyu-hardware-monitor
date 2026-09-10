export const MINIMUM_RULE_INTERVAL_SECONDS = 300;
export const MINIMUM_SEARCH_GAP_MS = 90_000;
export const VERIFICATION_COOLDOWN_MS = 30 * 60_000;
export const MAX_VERIFICATION_COOLDOWN_MS = 2 * 60 * 60_000;

export function nextAccessCooldownMs(blockCount) {
  const count = Math.max(1, Number(blockCount) || 1);
  return Math.min(
    MAX_VERIFICATION_COOLDOWN_MS,
    VERIFICATION_COOLDOWN_MS * (2 ** (count - 1))
  );
}

