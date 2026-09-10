import { categoryLabel } from "./categories.js";
import { evaluateListing } from "./filter.js";
import { VERIFICATION_COOLDOWN_MS, MINIMUM_SEARCH_GAP_MS, nextAccessCooldownMs } from "./pacing.js";

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

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

export class MonitorService {
  constructor({ database, browser, notifier }) {
    this.database = database;
    this.browser = browser;
    this.notifier = notifier;
    this.running = false;
    this.startedAt = null;
    this.lastActivity = "监控尚未启动";
    this.activeRuleId = null;
    this.loopPromise = null;
    this.notificationTimer = null;
    this.accessPauseUntil = Number(this.database.getSetting("xianyu_access_pause_until")) || 0;
    this.accessPaused = this.database.getSetting("xianyu_access_paused") === "1"
      || this.accessPauseUntil > Date.now();
    this.accessPauseKind = this.database.getSetting("xianyu_access_pause_kind") || "verification";
    this.lastResumeCheckAt = 0;
  }

  status() {
    const paused = this.#isAccessPaused();
    return {
      running: this.running,
      startedAt: this.startedAt,
      activeRuleId: this.activeRuleId,
      lastActivity: this.lastActivity,
      browser: this.browser.status(),
      astrbotConfigured: this.notifier.configured(),
      accessPaused: paused,
      accessPauseUntil: paused ? this.accessPauseUntil : 0,
      accessPauseKind: paused ? this.accessPauseKind : ""
    };
  }

  start() {
    if (this.running) {
      return this.status();
    }
    this.running = true;
    this.startedAt = Date.now();
    this.lastActivity = this.#isAccessPaused()
      ? this.#accessPauseMessage()
      : "监控已启动，等待符合扫描周期的规则。";
    this.loopPromise = this.#runLoop();
    this.notificationTimer = setInterval(() => {
      this.notifier.processOne().catch(() => {});
    }, 2_000);
    return this.status();
  }

  async stop() {
    this.running = false;
    if (this.notificationTimer) {
      clearInterval(this.notificationTimer);
      this.notificationTimer = null;
    }
    this.lastActivity = "监控已停止。";
    await this.loopPromise?.catch(() => {});
    return this.status();
  }

  async scanRule(rule, { force = false } = {}) {
    if (!force && !rule.enabled) {
      return { scanned: false, reason: "规则未启用", matched: 0, queued: 0 };
    }
    if (this.#isAccessPaused()) {
      const reason = this.#accessPauseMessage();
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
      for (const listing of listings) {
        const outcome = evaluateListing(rule, listing);
        if (!outcome.eligible) {
          continue;
        }
        const result = this.database.recordCandidateListing(
          rule,
          listing,
          outcome.price,
          !baseline && outcome.matched,
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
      this.lastActivity = baseline
        ? `已建立基线：${rule.name}，记录 ${listings.length} 个结果。`
        : `扫描完成：${rule.name}，低价匹配 ${matched} 个，已见未提醒 ${alreadySeen} 个，新增提醒 ${queued} 个${blocked ? `，已屏蔽 ${blocked} 个` : ""}。`;
      return { scanned: true, baseline, listings: listings.length, matched, alreadySeen, queued, blocked };
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
      const jitter = 5_000 + Math.floor(Math.random() * 20_000);
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
    const browserStatus = await this.browser.verifyLogin();
    if (browserStatus.state !== "verified") {
      await this.#pauseForAccess(
        browserStatus.state === "waiting_for_login" ? "login" : "verification"
      );
      throw new Error(browserStatus.message || "尚未完成登录或验证，自动搜索保持暂停。");
    }
    this.#clearAccessPause();
    this.database.postponeEnabledRules(Date.now(), MINIMUM_SEARCH_GAP_MS, { reset: true });
    this.lastActivity = "已确认闲鱼登录，自动搜索将按间隔恢复，不会立即连续扫描。";
    return this.status();
  }

  async #runLoop() {
    while (this.running) {
      if (this.#isAccessPaused()) {
        this.lastActivity = this.#accessPauseMessage();
        if (Date.now() >= this.accessPauseUntil && Date.now() - this.lastResumeCheckAt >= 60_000) {
          this.lastResumeCheckAt = Date.now();
          await this.#tryAutoResume();
        }
        await sleep(15_000);
        continue;
      }

      const rules = this.database.dueRules();
      if (!rules.length) {
        await sleep(3_000);
        continue;
      }

      for (const rule of rules) {
        if (!this.running || this.#isAccessPaused()) {
          break;
        }
        try {
          await this.scanRule(rule);
          await this.notifier.processOne();
        } catch {
          // The failure is persisted on the rule and surfaced in the console.
        }
        if (this.running && !this.#isAccessPaused()) {
          await sleep(2_000 + Math.floor(Math.random() * 4_000));
        }
      }
    }
  }

  #isAccessPaused() {
    return this.accessPaused;
  }

  async #tryAutoResume() {
    try {
      const browserStatus = await this.browser.verifyLogin();
      if (browserStatus.state === "verified") {
        this.#clearAccessPause();
        this.database.postponeEnabledRules(Date.now(), MINIMUM_SEARCH_GAP_MS, { reset: true });
        this.lastActivity = "登录状态已恢复，将按间隔继续扫描。";
        return;
      }
    } catch {
      // Keep the pause and wait for a human.
    }
    this.accessPauseUntil = Date.now() + VERIFICATION_COOLDOWN_MS;
    this.database.setSetting("xianyu_access_pause_until", this.accessPauseUntil);
    this.lastActivity = this.#accessPauseMessage();
  }

  async #pauseForAccess(kind) {
    this.accessPauseKind = kind === "login" ? "login" : "verification";
    if (!this.accessPaused) {
      const count = Number(this.database.getSetting("xianyu_access_block_count") || 0) + 1;
      this.database.setSetting("xianyu_access_block_count", String(count));
      this.accessPauseUntil = Date.now() + nextAccessCooldownMs(count);
      await this.#notifyAccessPause();
    } else {
      this.accessPauseUntil = Math.max(
        this.accessPauseUntil,
        Date.now() + VERIFICATION_COOLDOWN_MS
      );
    }
    this.accessPaused = true;
    this.database.setSetting("xianyu_access_paused", "1");
    this.database.setSetting("xianyu_access_pause_until", this.accessPauseUntil);
    this.database.setSetting("xianyu_access_pause_kind", this.accessPauseKind);
    this.database.postponeEnabledRules(this.accessPauseUntil, MINIMUM_SEARCH_GAP_MS);
    this.lastActivity = this.#accessPauseMessage();
  }

  #clearAccessPause() {
    this.accessPaused = false;
    this.accessPauseUntil = 0;
    this.accessPauseKind = "";
    this.database.setSetting("xianyu_access_paused", "0");
    this.database.setSetting("xianyu_access_pause_until", "0");
    this.database.setSetting("xianyu_access_pause_kind", "");
    this.database.setSetting("xianyu_pause_notified", "0");
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
      : "闲鱼硬件监控：闲鱼要求访问验证，自动搜索已暂停。请在电脑上人工完成验证后，点击“恢复扫描”。不会尝试绕过验证。";
    try {
      await this.notifier.sendMessage(message);
    } catch {
      // Listing alerts still use the retry queue; this is a one-shot status ping.
    }
  }

  #accessPauseMessage() {
    const action = "请在浏览器中人工处理后点击“恢复扫描”。";
    if (!this.accessPauseUntil) {
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
    return `${prefix}。最早 ${time} 后才会再次检查登录状态。${action}`;
  }
}
