import { categoryLabel } from "./categories.js";
import { evaluateListing } from "./filter.js";
import {
  VERIFICATION_COOLDOWN_MS,
  MINIMUM_SEARCH_GAP_MS,
  GLOBAL_SEARCH_INTERVAL_MIN_MS,
  GLOBAL_SEARCH_INTERVAL_MAX_MS,
  GLOBAL_SEARCH_SLOT_GRACE_MS,
  SEARCHES_PER_HOUR,
  SEARCH_WINDOW_MS,
  isQuietHours,
  nextActiveSearchTime,
  nextAccessCooldownMs,
  nextGlobalSearchDelayMs
} from "./pacing.js";

const GLOBAL_SEARCH_NEXT_AT_KEY = "xianyu_global_search_next_at";

function roundPrice(price) {
  return Number(price).toLocaleString("zh-CN", {
    maximumFractionDigits: 2
  });
}

function buildMessage(rule, listing, price) {
  return [
    "闲鱼低价提醒",
    `${categoryLabel(rule.category)} | ${rule.name}`,
    listing.title,
    `价格: ${roundPrice(price)} 元`,
    `价格区间: ${rule.minPriceCny === null ? "不限" : `${roundPrice(rule.minPriceCny)} 元`} - ${roundPrice(rule.maxPriceCny)} 元`,
    `商品链接: ${listing.url}`
  ].join("\n");
}

function isAccessBlockState(state) {
  return state === "waiting_for_verification" || state === "waiting_for_login";
}

function formatClock(timestamp) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(timestamp));
}

export class MonitorService {
  constructor({ database, browser, notifier, ai = null, random = Math.random }) {
    this.database = database;
    this.browser = browser;
    this.notifier = notifier;
    this.ai = ai;
    this.random = random;
    this.running = false;
    this.startedAt = null;
    this.lastActivity = "监控尚未启动";
    this.activeRuleId = null;
    this.loopPromise = null;
    this.notificationTimer = null;
    this.wakeLoop = null;
    this.accessPauseUntil = Number(this.database.getSetting("xianyu_access_pause_until")) || 0;
    this.accessPaused = this.database.getSetting("xianyu_access_paused") === "1"
      || this.accessPauseUntil > Date.now();
    this.accessPauseKind = this.database.getSetting("xianyu_access_pause_kind") || "verification";
    this.scanOperation = Promise.resolve();
    this.scanGeneration = 0;
    this.#resetOverdueGlobalSearchSlot();
  }

  status() {
    const paused = this.#isAccessPaused();
    return {
      running: this.running,
      startedAt: this.startedAt,
      activeRuleId: this.activeRuleId,
      lastActivity: paused ? this.#accessPauseMessage() : this.lastActivity,
      browser: this.browser.status(),
      astrbotConfigured: this.notifier.configured(),
      accessPaused: paused,
      accessPauseUntil: paused ? this.accessPauseUntil : 0,
      accessPauseKind: paused ? this.accessPauseKind : "",
      nextSearchAt: this.#globalSearchNextAt(),
      searchIntervalMinMs: this.#searchRange().min,
      searchIntervalMaxMs: this.#searchRange().max,
      quietHoursActive: isQuietHours(),
      searchesLastHour: this.database.recentSearchAttempts(Date.now() - SEARCH_WINDOW_MS).length,
      searchesPerHour: SEARCHES_PER_HOUR,
      backoffUntil: Number(this.database.getSetting("xianyu_backoff_until")) || 0,
      recoveryState: this.database.getSetting("xianyu_recovery_state") || "none"
    };
  }

  start() {
    if (this.running) {
      return this.status();
    }
    this.running = true;
    this.startedAt = Date.now();
    const nextSearchAt = this.#resetOverdueGlobalSearchSlot();
    this.lastActivity = this.#isAccessPaused()
      ? this.#accessPauseMessage()
      : isQuietHours()
        ? "夜间静默时段（00:00-08:00），低价搜索保持关闭。"
      : `监控已启动。下一次随机搜索预计在 ${formatClock(nextSearchAt)}。`;
    this.loopPromise = this.#runLoop();
    this.notificationTimer = setInterval(() => {
      this.notifier.processOne().catch(() => {});
    }, 2_000);
    return this.status();
  }

  async stop() {
    this.running = false;
    this.scanGeneration += 1;
    this.wakeLoop?.();
    if (this.notificationTimer) {
      clearInterval(this.notificationTimer);
      this.notificationTimer = null;
    }
    this.lastActivity = "监控已停止。";
    await this.loopPromise?.catch(() => {});
    await this.scanOperation;
    return this.status();
  }

  async #withScanOperation(callback) {
    const previous = this.scanOperation;
    let release;
    this.scanOperation = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  }

  async scanRule(rule, { force = false } = {}) {
    const generation = this.scanGeneration;
    return this.#withScanOperation(() => {
      const current = this.database.getRule(rule.id);
      if (generation !== this.scanGeneration || !current) {
        return { scanned: false, reason: "扫描已取消", matched: 0, queued: 0 };
      }
      return this.#scanRule(current, { force });
    });
  }

  async #scanRule(rule, { force }) {
    if (!force && !rule.enabled) {
      return { scanned: false, reason: "规则未启用", matched: 0, queued: 0 };
    }
    if (!force && rule.nextScanAt > Date.now()) {
      return { scanned: false, reason: "尚未到扫描时间", matched: 0, queued: 0 };
    }
    if (this.#isAccessPaused()) {
      const reason = this.#accessPauseMessage();
      this.lastActivity = reason;
      return { scanned: false, reason, matched: 0, queued: 0 };
    }
    if (isQuietHours()) {
      const reason = "夜间静默时段（00:00-08:00），低价搜索已关闭。";
      this.lastActivity = reason;
      return { scanned: false, reason, matched: 0, queued: 0 };
    }
    const globalSlot = this.#claimGlobalSearchSlot(rule.id);
    if (!globalSlot.allowed) {
      const reason = this.#globalSearchWaitMessage(globalSlot.nextSearchAt);
      this.lastActivity = reason;
      return { scanned: false, reason, matched: 0, queued: 0 };
    }

    this.activeRuleId = rule.id;
    this.lastActivity = `正在扫描：${rule.name}`;
    let errorMessage = null;
    const baseline = !rule.lastScannedAt;
    try {
      const listings = await this.browser.scan(rule);
      this.database.setSetting("xianyu_access_block_count", "0");
      let matched = 0;
      let queued = 0;
      let alreadySeen = 0;
      let blocked = 0;
      const evaluated = listings.map((listing) => ({
        listing,
        outcome: evaluateListing(rule, listing)
      }));
      const aiCandidates = !baseline && this.ai?.configured()
        ? evaluated.filter(({ listing, outcome }) => outcome.eligible && outcome.matched
          && !this.database.hasListing(rule.id, listing.itemId)
          && !this.database.isListingBlocked(listing.itemId)).map(({ listing, outcome }) => ({
          ...listing,
          price: outcome.price
        }))
        : [];
      const aiResult = aiCandidates.length
        ? await this.ai.reviewCandidates(rule, aiCandidates)
        : { decisions: new Map(), error: null };
      let aiFiltered = 0;
      let aiBlocked = 0;
      for (const { listing, outcome } of evaluated) {
        if (!outcome.eligible) {
          continue;
        }
        const aiDecision = aiResult.decisions.get(listing.itemId);
        const aiBlockedListing = outcome.matched && aiDecision?.block === true;
        const aiRejected = outcome.matched && aiDecision?.notify === false;
        if (aiBlockedListing) {
          this.database.blockListing({
            ...listing,
            blockReason: aiDecision.reason || "AI 判定为不适合的硬件商品"
          });
          aiFiltered += 1;
          aiBlocked += 1;
          blocked += 1;
          continue;
        }
        if (aiRejected) {
          aiFiltered += 1;
        }
        const result = this.database.recordCandidateListing(
          rule,
          listing,
          outcome.price,
          !baseline && outcome.matched && !aiRejected,
          buildMessage(rule, listing, outcome.price)
        );
        if (result.blocked) {
          blocked += 1;
          continue;
        }
        if (outcome.matched) {
          matched += 1;
        }
        if (result.queued) {
          queued += 1;
        }
        if (result.existing && outcome.matched) {
          alreadySeen += 1;
        }
      }
      const aiNote = aiResult.error
        ? `，AI 审核失败，已保留规则匹配结果`
        : aiFiltered
          ? `，AI 过滤 ${aiFiltered} 个疑似不匹配商品${aiBlocked ? `（已屏蔽 ${aiBlocked} 个）` : ""}`
          : "";
      this.lastActivity = baseline
        ? `已建立基线：${rule.name}，记录 ${listings.length} 个结果。`
        : `扫描完成：${rule.name}，低价匹配 ${matched} 个，已见未提醒 ${alreadySeen} 个，新增提醒 ${queued} 个${blocked ? `，已屏蔽 ${blocked} 个` : ""}${aiNote}。`;
      return { scanned: true, baseline, listings: listings.length, matched, alreadySeen, queued, blocked, aiFiltered, aiBlocked, aiError: aiResult.error };
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : "未知扫描错误";
      if (isAccessBlockState(this.browser.status().state)) {
        await this.#pauseForAccess(
          this.browser.status().state === "waiting_for_login" ? "login" : "verification"
        );
      } else {
        this.lastActivity = `扫描失败：${rule.name}，${errorMessage}`;
      }
      throw error;
    } finally {
      // A slow or interrupted scan must not consume the following waiting period.
      this.database.setSetting(
        GLOBAL_SEARCH_NEXT_AT_KEY,
        nextActiveSearchTime(Math.max(this.#globalSearchNextAt(), Date.now() + globalSlot.delayMs))
      );
      const jitter = 5_000 + Math.floor(this.random() * 20_000);
      let nextScanAt = Date.now() + rule.scanIntervalSeconds * 1_000 + jitter;
      if (this.#isAccessPaused()) {
        nextScanAt = Math.max(nextScanAt, this.accessPauseUntil + MINIMUM_SEARCH_GAP_MS);
      }
      this.database.markRuleScanned(rule.id, { nextScanAt, error: errorMessage });
      this.activeRuleId = null;
    }
  }

  async scanNow(ruleId) {
    const rule = this.database.getRule(Number(ruleId));
    if (!rule) {
      throw new Error("未找到该规则");
    }
    const result = await this.scanRule(rule, { force: true });
    await this.notifier.processOne();
    return result;
  }

  async resumeAfterHumanCheck() {
    return this.#withScanOperation(async () => {
      if (!this.#isAccessPaused()) {
        return this.status();
      }
      if (this.accessPauseKind === "verification" && Date.now() < this.accessPauseUntil) {
        throw new Error(`访问验证冷却尚未结束。${this.#accessPauseMessage()}`);
      }
      const browserStatus = await this.browser.verifyLogin();
      if (browserStatus.state !== "verified") {
        await this.#pauseForAccess(
          browserStatus.state === "waiting_for_login" ? "login" : "verification"
        );
        throw new Error(browserStatus.message || "尚未完成登录或验证，自动搜索保持暂停。");
      }
      this.#clearAccessPause();
      this.database.postponeEnabledRules(Date.now(), MINIMUM_SEARCH_GAP_MS, { reset: true });
      const nextSearchAt = this.#resetOverdueGlobalSearchSlot();
      this.lastActivity = this.running
        ? `已确认闲鱼登录，自动搜索将按低频节奏恢复，下一次预计在 ${formatClock(nextSearchAt)}。`
        : "已解除访问暂停；监控仍处于停止状态。";
      return this.status();
    });
  }

  async #runLoop() {
    while (this.running) {
      if (this.#isAccessPaused()) {
        this.lastActivity = this.#accessPauseMessage();
        await this.#reopenAfterCooldown();
        await this.#waitForLoop(15_000);
        continue;
      }
      if (isQuietHours()) {
        this.lastActivity = "夜间静默时段（00:00-08:00），低价搜索保持关闭。";
        await this.#waitForLoop(15_000);
        continue;
      }

      const nextSearchAt = this.#resetOverdueGlobalSearchSlot({ allowDue: true });
      if (nextSearchAt > Date.now()) {
        await this.#waitForLoop(Math.min(15_000, nextSearchAt - Date.now()));
        continue;
      }

      const rules = this.database.dueRules();
      if (!rules.length) {
        this.lastActivity = "等待已启用规则到期；到期后只会搜索其中一条。";
        await this.#waitForLoop(15_000);
        continue;
      }

      try {
        await this.scanRule(rules[0]);
        await this.notifier.processOne();
      } catch {
        // The failure is persisted on the rule and surfaced in the console.
      }
    }
  }

  #waitForLoop(milliseconds) {
    if (!this.running) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.wakeLoop = null;
        resolve();
      };
      const timer = setTimeout(wake, Math.max(0, milliseconds));
      this.wakeLoop = wake;
    });
  }

  #globalSearchNextAt() {
    const value = Number(this.database.getSetting(GLOBAL_SEARCH_NEXT_AT_KEY));
    return value > 0 && Number.isSafeInteger(value) && Number.isFinite(new Date(value).getTime())
      ? value
      : 0;
  }

  #scheduleGlobalSearchAfter(timestamp) {
    const range = this.#searchRange();
    const delay = range.min + Math.floor(this.random() * (range.max - range.min));
    const nextSearchAt = nextActiveSearchTime(timestamp + delay);
    this.database.setSetting(GLOBAL_SEARCH_NEXT_AT_KEY, nextSearchAt);
    return nextSearchAt;
  }

  #resetOverdueGlobalSearchSlot({ allowDue = false } = {}) {
    const nextSearchAt = this.#globalSearchNextAt();
    const cutoff = Date.now() - (allowDue ? GLOBAL_SEARCH_SLOT_GRACE_MS : 0);
    return nextSearchAt && nextSearchAt > cutoff
      ? nextSearchAt
      : this.#scheduleGlobalSearchAfter(Date.now());
  }

  #claimGlobalSearchSlot(ruleId) {
    const nextSearchAt = this.#resetOverdueGlobalSearchSlot({ allowDue: true });
    if (nextSearchAt > Date.now()) {
      return { allowed: false, nextSearchAt };
    }
    // Reserve before browser access so a crash or request failure cannot trigger an immediate retry.
    const now = Date.now();
    const attempts = this.database.recentSearchAttempts(now - SEARCH_WINDOW_MS);
    if (attempts.length >= SEARCHES_PER_HOUR) {
      const nextSearchAt = nextActiveSearchTime(attempts[attempts.length - SEARCHES_PER_HOUR] + SEARCH_WINDOW_MS + 1);
      this.database.setSetting(GLOBAL_SEARCH_NEXT_AT_KEY, nextSearchAt);
      return { allowed: false, nextSearchAt };
    }
    const range = this.#searchRange();
    const delayMs = range.min + Math.floor(this.random() * (range.max - range.min));
    const reservedAt = nextActiveSearchTime(now + delayMs);
    this.database.reserveSearchAttempt(ruleId, now, reservedAt);
    return {
      allowed: true,
      nextSearchAt: reservedAt,
      delayMs
    };
  }

  #searchRange() {
    return Number(this.database.getSetting("xianyu_backoff_until")) > Date.now()
      ? { min: 90 * 60_000, max: 120 * 60_000 }
      : { min: GLOBAL_SEARCH_INTERVAL_MIN_MS, max: GLOBAL_SEARCH_INTERVAL_MAX_MS };
  }

  #globalSearchWaitMessage(nextSearchAt) {
    return `全局低频保护已启用：下一次仅搜索一条规则，预计在 ${formatClock(nextSearchAt)}。`;
  }

  #isAccessPaused() {
    return this.accessPaused;
  }

  async #pauseForAccess(kind) {
    const newPause = !this.accessPaused;
    if (!this.accessPaused) {
      this.accessPauseKind = kind === "login" ? "login" : "verification";
      const count = Number(this.database.getSetting("xianyu_access_block_count") || 0) + 1;
      this.database.setSetting("xianyu_access_block_count", String(count));
      this.accessPauseUntil = Date.now() + nextAccessCooldownMs(count);
    } else if (kind === "verification" && this.accessPauseKind === "login") {
      this.accessPauseKind = "verification";
      this.accessPauseUntil = Math.max(
        this.accessPauseUntil,
        Date.now() + VERIFICATION_COOLDOWN_MS
      );
    }
    this.accessPaused = true;
    this.database.setSetting("xianyu_access_paused", "1");
    this.database.setSetting("xianyu_access_pause_until", this.accessPauseUntil);
    this.database.setSetting("xianyu_access_pause_kind", this.accessPauseKind);
    this.database.setSetting("xianyu_backoff_until", Date.now() + 6 * 60 * 60_000);
    this.database.postponeEnabledRules(this.accessPauseUntil, MINIMUM_SEARCH_GAP_MS);
    this.lastActivity = this.#accessPauseMessage();
    if (newPause) {
      this.database.setSetting("xianyu_recovery_state", "cooling");
      if (typeof this.browser.close === "function") {
        await this.browser.close().catch(() => {
          this.database.setSetting("xianyu_recovery_state", "close_failed");
        });
      }
      await this.#notifyAccessPause();
    }
  }

  async #reopenAfterCooldown() {
    if (this.database.getSetting("xianyu_recovery_state") !== "cooling"
      || Date.now() < this.accessPauseUntil || isQuietHours()) {
      return;
    }
    // Persist before opening: restarting cannot produce repeated login windows.
    this.database.setSetting("xianyu_recovery_state", "awaiting_human");
    try {
      await this.browser.openLogin();
    } catch {
      this.database.setSetting("xianyu_recovery_state", "open_failed");
    }
  }

  #clearAccessPause() {
    this.accessPaused = false;
    this.accessPauseUntil = 0;
    this.accessPauseKind = "";
    this.database.setSetting("xianyu_access_paused", "0");
    this.database.setSetting("xianyu_access_pause_until", "0");
    this.database.setSetting("xianyu_access_pause_kind", "");
    this.database.setSetting("xianyu_pause_notified", "0");
    this.database.setSetting("xianyu_recovery_state", "none");
  }

  async #notifyAccessPause() {
    if (this.database.getSetting("xianyu_pause_notified") === "1") {
      return;
    }
    this.database.setSetting("xianyu_pause_notified", "1");
    if (!this.notifier.configured()) {
      return;
    }
    const message = this.accessPauseKind === "login"
      ? "闲鱼硬件监控：登录已失效，自动搜索已暂停。请在电脑上打开浏览器完成登录后，点击“恢复扫描”。"
      : "闲鱼硬件监控：闲鱼要求访问验证，自动搜索已暂停。请在电脑上人工完成验证，冷却结束后点击“恢复扫描”。不会自动重试或绕过验证。";
    try {
      await this.notifier.sendMessage(message);
    } catch {
      // Listing alerts still use the retry queue; this is a one-shot status ping.
    }
  }

  #accessPauseMessage() {
    const action = "请在浏览器中人工处理后点击“恢复扫描”。";
    if (this.accessPauseKind === "login" || this.accessPauseUntil <= Date.now()) {
      return this.accessPauseKind === "login"
        ? `闲鱼登录失效，已暂停自动搜索。${action}`
        : `闲鱼访问验证后已暂停自动搜索。${action}`;
    }
    const time = new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit"
    }).format(new Date(this.accessPauseUntil));
    const prefix = this.accessPauseKind === "login"
      ? "闲鱼登录失效，已暂停自动搜索"
      : "闲鱼访问验证后已暂停自动搜索";
    return `${prefix}。冷却至 ${time}，到时仍需手动恢复。${action}`;
  }
}
