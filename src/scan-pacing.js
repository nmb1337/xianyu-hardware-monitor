// Human-like scan pacing: time window, randomized intervals, breaks, daily caps
// and the verification cooldown. Defaults keep the automation quiet by design.
export const DEFAULT_SCAN_PACING = {
  windowStart: "09:00",
  windowEnd: "23:00",
  windowJitterMinutes: 30,
  intervalMinSec: 120,
  intervalMaxSec: 300,
  dailyLimit: 120,
  cooldownMinutes: 120,
  breakEveryMin: 8,
  breakEveryMax: 15,
  breakMinutesMin: 10,
  breakMinutesMax: 40,
  observationHours: 24
};

export function parseTimeToMinutes(value, fallbackMinutes) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? "").trim());
  if (!match) {
    return fallbackMinutes;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return fallbackMinutes;
  }
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return fallbackMinutes;
  }
  return hours * 60 + minutes;
}

export function minutesToTime(totalMinutes) {
  const normalized = ((Math.round(totalMinutes) % 1440) + 1440) % 1440;
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function clampInteger(value, minimum, maximum, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
}

export function normalizeScanPacing(input = {}) {
  const source = { ...DEFAULT_SCAN_PACING, ...(input && typeof input === "object" ? input : {}) };
  const defaultStart = parseTimeToMinutes(DEFAULT_SCAN_PACING.windowStart, 540);
  const defaultEnd = parseTimeToMinutes(DEFAULT_SCAN_PACING.windowEnd, 1380);
  const startMinutes = parseTimeToMinutes(source.windowStart, defaultStart);
  let endMinutes = parseTimeToMinutes(source.windowEnd, defaultEnd);
  if (endMinutes <= startMinutes) {
    // A window must have a positive length; fall back to the default span on bad input.
    endMinutes = Math.min(1439, startMinutes + Math.max(60, defaultEnd - defaultStart));
  }
  const intervalMinSec = clampInteger(source.intervalMinSec, 30, 3600, DEFAULT_SCAN_PACING.intervalMinSec);
  const intervalMaxSec = Math.max(
    intervalMinSec,
    clampInteger(source.intervalMaxSec, 30, 7200, DEFAULT_SCAN_PACING.intervalMaxSec)
  );
  const breakEveryMin = clampInteger(source.breakEveryMin, 2, 100, DEFAULT_SCAN_PACING.breakEveryMin);
  const breakEveryMax = Math.max(
    breakEveryMin,
    clampInteger(source.breakEveryMax, 2, 200, DEFAULT_SCAN_PACING.breakEveryMax)
  );
  const breakMinutesMin = clampInteger(source.breakMinutesMin, 1, 240, DEFAULT_SCAN_PACING.breakMinutesMin);
  const breakMinutesMax = Math.max(
    breakMinutesMin,
    clampInteger(source.breakMinutesMax, 1, 480, DEFAULT_SCAN_PACING.breakMinutesMax)
  );
  return {
    windowStart: minutesToTime(startMinutes),
    windowEnd: minutesToTime(endMinutes),
    windowJitterMinutes: clampInteger(source.windowJitterMinutes, 0, 120, DEFAULT_SCAN_PACING.windowJitterMinutes),
    intervalMinSec,
    intervalMaxSec,
    dailyLimit: clampInteger(source.dailyLimit, 1, 2000, DEFAULT_SCAN_PACING.dailyLimit),
    cooldownMinutes: clampInteger(source.cooldownMinutes, 5, 1440, DEFAULT_SCAN_PACING.cooldownMinutes),
    breakEveryMin,
    breakEveryMax,
    breakMinutesMin,
    breakMinutesMax,
    observationHours: clampInteger(source.observationHours, 0, 168, DEFAULT_SCAN_PACING.observationHours)
  };
}
