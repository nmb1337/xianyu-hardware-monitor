export const COMPONENT_MIN_SCAN_INTERVAL_SECONDS = 600;
export const DESKTOP_MIN_SCAN_INTERVAL_SECONDS = 900;
export const MANUAL_SCAN_COOLDOWN_SECONDS = 600;
export const RULE_GAP_MIN_MILLISECONDS = 45_000;
export const RULE_GAP_MAX_MILLISECONDS = 90_000;
export const SEARCH_INITIAL_WAIT_MIN_MILLISECONDS = 6_000;
export const SEARCH_INITIAL_WAIT_MAX_MILLISECONDS = 10_000;
export const SEARCH_ACTION_WAIT_MIN_MILLISECONDS = 2_000;
export const SEARCH_ACTION_WAIT_MAX_MILLISECONDS = 5_000;
export const DESKTOP_DETAIL_LIMIT = 8;
export const DESKTOP_DETAIL_WAIT_MIN_MILLISECONDS = 4_000;
export const DESKTOP_DETAIL_WAIT_MAX_MILLISECONDS = 8_000;

export function isDesktopValuationMode(mode) {
  return String(mode ?? "").trim() === "desktop_host";
}

export function minimumScanIntervalSeconds(mode) {
  return isDesktopValuationMode(mode)
    ? DESKTOP_MIN_SCAN_INTERVAL_SECONDS
    : COMPONENT_MIN_SCAN_INTERVAL_SECONDS;
}

export function normalizeScanIntervalSeconds(value, mode) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return minimumScanIntervalSeconds(mode);
  }
  return Math.min(
    86_400,
    Math.max(minimumScanIntervalSeconds(mode), Math.round(parsed))
  );
}

export function randomBetween(minimum, maximum) {
  return minimum + Math.floor(Math.random() * (maximum - minimum + 1));
}

export function isAccessPauseError(error, browserState = "") {
  const source = `${error instanceof Error ? error.message : error}\n${browserState}`.toLowerCase();
  return /验证码|安全验证|滑块|操作过于频繁|访问异常|请先登录|扫码登录|登录失效|waiting_for_verification|captcha|x5sec|too many requests|rate limit/.test(
    source
  );
}
