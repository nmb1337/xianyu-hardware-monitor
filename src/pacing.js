export const MINIMUM_RULE_INTERVAL_SECONDS = 300;
export const MINIMUM_SEARCH_GAP_MS = 90_000;
export const GLOBAL_SEARCH_INTERVAL_MIN_MS = 10 * 60_000;
export const GLOBAL_SEARCH_INTERVAL_MAX_MS = 14 * 60_000;
export const SEARCHES_PER_HOUR = 5;
export const SEARCH_WINDOW_MS = 60 * 60_000;
export const GLOBAL_SEARCH_SLOT_GRACE_MS = 60_000;
export const QUIET_HOURS_START = 0;
export const QUIET_HOURS_END = 8;
export const VERIFICATION_COOLDOWN_MS = 30 * 60_000;
export const MAX_VERIFICATION_COOLDOWN_MS = 2 * 60 * 60_000;

export function nextGlobalSearchDelayMs(random = Math.random) {
  const sample = Math.min(1, Math.max(0, Number(random()) || 0));
  return GLOBAL_SEARCH_INTERVAL_MIN_MS + Math.floor(
    sample * (GLOBAL_SEARCH_INTERVAL_MAX_MS - GLOBAL_SEARCH_INTERVAL_MIN_MS)
  );
}

export function isQuietHours(timestamp = Date.now(), timeZone = "Asia/Shanghai") {
  const hour = Number(new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    hourCycle: "h23"
  }).format(new Date(timestamp)));
  return hour >= QUIET_HOURS_START && hour < QUIET_HOURS_END;
}

export function nextActiveSearchTime(timestamp) {
  if (!isQuietHours(timestamp)) {
    return timestamp;
  }
  // China has no daylight-saving changes in this application's supported schedule.
  const local = new Date(timestamp + 8 * 60 * 60_000);
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 0, 0);
}

export function nextAccessCooldownMs(blockCount) {
  const count = Math.max(1, Number(blockCount) || 1);
  return Math.min(
    MAX_VERIFICATION_COOLDOWN_MS,
    VERIFICATION_COOLDOWN_MS * (2 ** (count - 1))
  );
}
