import { categoryLabel } from "./categories.js";
import { evaluateListing } from "./filter.js";

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
  }

  status() {
    return {
      running: this.running,
      startedAt: this.startedAt,
      activeRuleId: this.activeRuleId,
      lastActivity: this.lastActivity,
      browser: this.browser.status(),
      astrbotConfigured: this.notifier.configured()
    };
  }

  start() {
    if (this.running) {
      return this.status();
    }
    this.running = true;
    this.startedAt = Date.now();
    this.lastActivity = "监控已启动，等待符合扫描周期的规则。";
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

    this.activeRuleId = rule.id;
    this.lastActivity = `正在扫描：${rule.name}`;
    let errorMessage = null;
    const baseline = !rule.lastScannedAt;
    try {
      const listings = await this.browser.scan(rule);
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
      this.lastActivity = `扫描失败：${rule.name}，${errorMessage}`;
      throw error;
    } finally {
      const jitter = 5_000 + Math.floor(Math.random() * 20_000);
      const nextScanAt = Date.now() + rule.scanIntervalSeconds * 1_000 + jitter;
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

  async #runLoop() {
    while (this.running) {
      const rules = this.database.dueRules();
      if (!rules.length) {
        await sleep(3_000);
        continue;
      }

      for (const rule of rules) {
        if (!this.running) {
          break;
        }
        try {
          await this.scanRule(rule);
          await this.notifier.processOne();
        } catch {
          // The failure is persisted on the rule and surfaced in the console.
        }
        if (this.running) {
          await sleep(2_000 + Math.floor(Math.random() * 4_000));
        }
      }
    }
  }
}
