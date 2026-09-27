import { categoryLabel } from "./categories.js";
import { evaluateListing } from "./filter.js";

import { minutesToTime, normalizeScanPacing, parseTimeToMinutes } from "./scan-pacing.js";

function randomBetween(minimum, maximum) {
  return minimum + Math.floor(Math.random() * (maximum - minimum + 1));
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

function buildMachineMessage(listing, appraisal) {
  const lines = [];
  if (appraisal) {
    const priced = appraisal.parts.filter((part) => part.price > 0);
    const unpriced = appraisal.parts.filter((part) => part.status === "unpriced");
    const diffText = appraisal.diff === null
      ? "—"
      : `${appraisal.diff > 0 ? "+" : ""}${roundPrice(appraisal.diff)}`;
    lines.push(`【整机疑似低价】${listing.title}`);
    lines.push(`卖家价 ¥${roundPrice(listing.price)}｜表价合计 ¥${roundPrice(appraisal.sum)}｜净差 ${diffText}（±${appraisal.tolerance} 内推送）`);
    if (priced.length) {
      lines.push(`清单：${priced.map((part) => `${part.label}=${roundPrice(part.price)}`).join(" / ")}`);
    }
    if (unpriced.length) {
      lines.push(`未计价：${unpriced.map((part) => part.label).join("、")}`);
    }
    if (appraisal.flags.length) {
      lines.push(`提示：${appraisal.flags.slice(0, 5).join("；")}`);
    }
  } else {
    lines.push(`【整机扫描】${listing.title}`);
    lines.push(`卖家价 ¥${roundPrice(listing.price)}（估价引擎未启用）`);
  }
  lines.push(`商品链接: ${listing.url}`);
  return lines.join("\n");
}

function isAccessBlockState(state) {
  return state === "waiting_for_verification" || state === "waiting_for_login";
}

export class MonitorService {
  constructor({ database, browser, notifier, ai = null, appraiser = null }) {
    this.database = database;
    this.browser = browser;
    this.notifier = notifier;
    this.ai = ai;
    this.appraiser = appraiser;
    this.running = false;
    this.startedAt = null;
    this.lastActivity = "监控尚未启动";
    this.activeRuleId = null;
    this.lastScannedRuleId = null;
    this.loopPromise = null;
    this.notificationTimer = null;
    this.wakeLoop = null;
    this.accessPaused = false;
    this.accessPauseKind = "";
    this.accessRecoveryState = "none";
    this.accessPauseNotified = false;
    this.manualRecoveryNoticeSent = false;
    this.recoveryReportPending = false;
    this.scanOperation = Promise.resolve();
    this.scanGeneration = 0;
    this.restartLoginPromise = null;
    // True while the user is expected to scan a QR code in the login window we opened.
    this.manualLoginMode = false;
    // Human-like pacing state: window / interval / long breaks / daily caps / verification cooldown.
    this.pacingCache = null;
    this.pacingCacheAt = 0;
    this.windowCache = null;
    this.scansSinceBreak = 0;
    this.breakTarget = 0;
    this.dailyScans = new Map();
    this.dailyScansDay = "";
    this.verificationCooldownUntil = 0;
    this.autoRecoveryAttempts = 0;
    // 轮换：standard（用户的显卡等规则）与 machine（整机自动扫描）交替进行。
    this.nextScanKind = "standard";
    // 两类规则各自记录“上一条扫过的”，分组轮换才不会互相干扰。
    this.lastStandardRuleId = null;
    this.lastMachineRuleId = null;
  }

  status() {
    const paused = this.#isAccessPaused();
    const enabledRules = this.database.listRules().filter((rule) => rule.enabled);
    const nextRule = this.#nextRule(enabledRules);
    const window = this.#todayWindow();
    const withinWindow = this.#withinWindow();
    const nextWindow = withinWindow ? null : this.#nextWindowStart();
    return {
      running: this.running,
      startedAt: this.startedAt,
      activeRuleId: this.activeRuleId,
      lastActivity: paused ? this.#accessPauseMessage() : this.lastActivity,
      browser: this.browser.status(),
      astrbotConfigured: this.notifier.configured(),
      accessPaused: paused,
      accessPauseKind: paused ? this.accessPauseKind : "",
      recoveryState: paused ? this.accessRecoveryState : "none",
      enabledRuleCount: enabledRules.length,
      nextRuleId: nextRule?.id ?? null,
      nextRuleName: nextRule?.name ?? "",
      lastScannedRuleId: this.lastScannedRuleId,
      scanWindowLabel: `${minutesToTime(window.start)}–${minutesToTime(window.end)}`,
      scanResting: !withinWindow,
      nextWindowLabel: nextWindow ? `${nextWindow.tomorrow ? "明天" : "今天"} ${minutesToTime(nextWindow.minutes)}` : "",
      observing: this.#observing()
    };
  }

  start() {
    if (this.running) {
      return this.status();
    }
    this.running = true;
    this.startedAt = Date.now();
    this.#ensureMachineRules();
    const pacing = this.#pacing();
    this.lastActivity = this.#isAccessPaused()
      ? this.#accessPauseMessage()
      : `监控已启动：活跃时段 ${pacing.windowStart}–${pacing.windowEnd}，间隔随机 ${pacing.intervalMinSec}–${pacing.intervalMaxSec} 秒，每轮随机休息；每天每条上限 ${pacing.dailyLimit} 次。`;
    this.loopPromise = this.#runLoop();
    this.notificationTimer = setInterval(() => {
      this.notifier.processOne().catch(() => {});
    }, 2_000);
    return this.status();
  }

  async stop() {
    this.running = false;
    this.scanGeneration += 1;
    this.ai?.cancelPending?.();
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
    if (this.#isAccessPaused()) {
      const reason = this.#accessPauseMessage();
      this.lastActivity = reason;
      return { scanned: false, reason, matched: 0, queued: 0 };
    }

    // Count every scan attempt, even failed ones, so the daily cap cannot be bypassed by errors.
    this.dailyScans.set(rule.id, this.#scanCount(rule.id) + 1);
    this.autoRecoveryAttempts = 0;
    this.activeRuleId = rule.id;
    const generation = this.scanGeneration;
    this.lastActivity = `正在扫描：${rule.name}`;
    let errorMessage = null;
    const baseline = !rule.lastScannedAt;
    try {
      const listings = await this.browser.scan(rule);
      this.manualLoginMode = false;
      if (rule.kind === "machine") {
        const summary = await this.#evaluateMachineListings(rule, listings, { baseline, generation });
        await this.#reportRecoveryScan(`恢复后首次扫描完成。\n${this.lastActivity}`);
        return summary;
      }
      let matched = 0;
      let queued = 0;
      let alreadySeen = 0;
      let blocked = 0;
      const evaluated = listings.map((listing) => ({
        listing,
        outcome: evaluateListing(rule, listing)
      }));
      const aiCandidates = generation === this.scanGeneration && !baseline && this.ai?.configured()
        ? evaluated.filter(({ listing, outcome }) => outcome.eligible && outcome.matched
          && !this.database.hasListing(rule.id, listing.itemId)
          && !this.database.isListingBlocked(listing.itemId)
          && !this.database.isAiExempt(listing.itemId)).map(({ listing, outcome }) => ({
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
        // Restored items are never filtered or blocked again by AI decisions.
        const aiDecision = this.database.isAiExempt(listing.itemId)
          ? undefined
          : aiResult.decisions.get(listing.itemId);
        const aiBlockedListing = outcome.matched && aiDecision?.block === true;
        const aiRejected = outcome.matched && aiDecision?.notify === false;
        if (aiRejected) {
          this.database.recordAiRejection(rule, { ...listing, price: outcome.price }, aiDecision);
        }
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
      const aiNote = aiResult.cancelled
        ? `，AI 审核已取消，已保留规则匹配结果`
        : aiResult.error
          ? aiResult.decisions.size
            ? `，AI 审核部分失败，未审核商品已照常提醒`
            : `，AI 审核失败，已保留规则匹配结果`
          : aiFiltered
            ? `，AI 过滤 ${aiFiltered} 个疑似不匹配商品${aiBlocked ? `（已屏蔽 ${aiBlocked} 个）` : ""}`
            : "";
      this.lastActivity = baseline
        ? `已建立基线：${rule.name}，记录 ${listings.length} 个结果。`
        : `扫描完成：${rule.name}，低价匹配 ${matched} 个，已见未提醒 ${alreadySeen} 个，新增提醒 ${queued} 个${blocked ? `，已屏蔽 ${blocked} 个` : ""}${aiNote}。`;
      await this.#reportRecoveryScan(`恢复后首次扫描完成。\n${this.lastActivity}`);
      return { scanned: true, baseline, listings: listings.length, matched, alreadySeen, queued, blocked, aiFiltered, aiBlocked, aiError: aiResult.error };
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : "未知扫描错误";
      const browserState = this.browser.status().state;
      if (isAccessBlockState(browserState)) {
        await this.#pauseForAccess(browserState === "waiting_for_login" ? "login" : "verification");
      } else {
        this.lastActivity = `扫描失败：${rule.name}，${errorMessage}`;
        await this.#reportRecoveryScan(`恢复后首次扫描未完成。\n${this.lastActivity}`);
      }
      throw error;
    } finally {
      this.database.markRuleScanned(rule.id, { error: errorMessage });
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

  restartLogin() {
    if (this.restartLoginPromise) {
      return this.restartLoginPromise;
    }
    this.manualLoginMode = true;
    this.scanGeneration += 1;
    this.ai?.cancelPending?.();
    this.restartLoginPromise = this.#withScanOperation(async () => {
      this.accessPaused = true;
      if (!this.accessPauseKind) {
        this.accessPauseKind = "login";
      }
      await this.#openBrowser({ restart: true });
      return this.status();
    }).finally(() => {
      this.restartLoginPromise = null;
    });
    return this.restartLoginPromise;
  }

  async openLogin() {
    this.manualLoginMode = true;
    return this.#withScanOperation(async () => {
      if (this.#isAccessPaused()) {
        await this.#openBrowser();
        return this.browser.status();
      }
      return this.browser.openLogin();
    });
  }

  async closeBrowser() {
    this.manualLoginMode = false;
    this.scanGeneration += 1;
    this.ai?.cancelPending?.();
    return this.#withScanOperation(async () => {
      if (this.#isAccessPaused()) {
        this.accessRecoveryState = "closed_by_user";
      }
      try {
        return await this.browser.close();
      } catch (error) {
        if (this.#isAccessPaused()) {
          this.accessRecoveryState = "close_failed";
        }
        throw error;
      }
    });
  }

  async resetBrowserProfile() {
    this.manualLoginMode = false;
    this.scanGeneration += 1;
    this.ai?.cancelPending?.();
    return this.#withScanOperation(async () => {
      if (this.#isAccessPaused()) {
        // The cleared profile also clears the login; stay paused until the user asks again.
        this.accessRecoveryState = "closed_by_user";
      }
      const status = await this.browser.resetProfile();
      this.lastActivity = "浏览器资料已清空（相当于换新设备），请点“打开登录”重新扫码。";
      return status;
    });
  }

  async switchBrowser() {
    this.manualLoginMode = true;
    return this.#withScanOperation(async () => {
      if (this.activeRuleId) {
        throw new Error("当前仍在扫描，请等待本轮结束后再切换浏览器。");
      }
      this.scanGeneration += 1;
      this.ai?.cancelPending?.();
      await this.browser.switchBrowser();
      if (this.#isAccessPaused()) {
        await this.#openBrowser();
        return this.status();
      }
      try {
        await this.browser.openLogin();
      } catch {
        throw new Error("备用浏览器打开失败，请检查浏览器后重试。");
      }
      this.lastActivity = `已切换到 ${this.browser.status().browserName}。`;
      return this.status();
    });
  }

  async verifyLogin() {
    return this.#withScanOperation(async () => {
      const status = await this.browser.verifyLogin();
      if (this.#isAccessPaused() && status.state === "verified") {
        await this.#completeAccessRecovery();
      }
      return status;
    });
  }

  async resumeAfterHumanCheck() {
    return this.#withScanOperation(async () => {
      if (!this.#isAccessPaused()) {
        return this.status();
      }
      const browserStatus = await this.browser.verifyLogin();
      if (browserStatus.state !== "verified") {
        throw new Error(browserStatus.message || "尚未完成登录或验证，自动查询保持暂停。");
      }
      return this.#completeAccessRecovery();
    });
  }

  async #completeAccessRecovery({ automatic = false } = {}) {
    const recoveredKind = this.accessPauseKind;
    this.manualLoginMode = false;
    this.accessPaused = false;
    this.accessPauseKind = "";
    this.accessRecoveryState = "none";
    this.accessPauseNotified = false;
    this.manualRecoveryNoticeSent = false;
    this.recoveryReportPending = true;
    this.verificationCooldownUntil = 0;
    this.autoRecoveryAttempts = 0;
    if (recoveredKind === "verification") {
      // Start the low-speed observation window after any verification event.
      try {
        this.database.setSetting("last_verification_at", String(Date.now()));
      } catch { }
    }
    this.lastActivity = this.running
      ? `${automatic ? "已自动确认闲鱼登录" : "已确认闲鱼登录"}，继续按规则顺序查询。`
      : "已确认闲鱼登录；监控仍处于停止状态。";
    await this.#sendStatusMessage(`登录已恢复。${this.lastActivity}${this.running
      ? "恢复后的首次扫描会汇报结果；没有新低价商品也会汇报。"
      : "启动监控后会继续查询。"}`);
    this.wakeLoop?.();
    return this.status();
  }

  async #runLoop() {
    while (this.running) {
      if (this.manualLoginMode && !this.#isAccessPaused()) {
        await this.#awaitManualLogin();
        continue;
      }
      if (this.#isAccessPaused()) {
        await this.#recoverAccess();
        if (this.#isAccessPaused()) {
          await this.#waitForLoop(15_000);
        }
        continue;
      }

      if (!this.#withinWindow()) {
        const window = this.#todayWindow();
        const next = this.#nextWindowStart();
        this.lastActivity = `非扫描时段（今日窗口 ${minutesToTime(window.start)}–${minutesToTime(window.end)}），休息中；${next.tomorrow ? "明天" : "今天"} ${minutesToTime(next.minutes)} 恢复查询。`;
        await this.#waitForLoop(Math.min(this.#msUntilWindowStart(), 10 * 60_000));
        continue;
      }

      const rules = this.database.enabledRulesInOrder();
      if (!rules.length) {
        this.lastActivity = "没有已启用的规则，等待添加。";
        await this.#waitForLoop(15_000);
        continue;
      }

      const observation = this.#observing();
      const dailyLimit = Math.max(1, Math.floor(this.#pacing().dailyLimit * (observation ? 0.5 : 1)));
      const scannable = rules.filter((rule) => this.#scanCount(rule.id) < dailyLimit);
      if (!scannable.length) {
        this.lastActivity = `今日查询已达上限（每条规则 ${dailyLimit} 次），今天不再扫描，明天继续。`;
        await this.#waitForLoop(Math.min(this.#msUntilMidnight(), 10 * 60_000));
        continue;
      }

      // 交替轮换：一个用户规则（显卡等）→ 一个整机自动扫描 → 循环。
      const standards = scannable.filter((item) => item.kind !== "machine");
      const machines = scannable.filter((item) => item.kind === "machine");
      let rule;
      if (this.nextScanKind === "machine" && machines.length) {
        rule = this.#nextRule(machines, this.lastMachineRuleId);
        this.nextScanKind = "standard";
      } else if (standards.length) {
        rule = this.#nextRule(standards, this.lastStandardRuleId);
        this.nextScanKind = machines.length ? "machine" : "standard";
      } else {
        rule = this.#nextRule(machines, this.lastMachineRuleId);
        this.nextScanKind = "standard";
      }
      try {
        await this.scanRule(rule);
      } catch {
        // The failure is recorded on the rule; keep the rotation moving.
      } finally {
        this.lastScannedRuleId = rule.id;
        if (rule.kind === "machine") {
          this.lastMachineRuleId = rule.id;
        } else {
          this.lastStandardRuleId = rule.id;
        }
      }
      await this.notifier.processOne();
      // Yield to the event loop so even instant failures cannot starve the process.
      await new Promise((resolve) => setImmediate(resolve));
      if (this.#isAccessPaused() || this.manualLoginMode) {
        // Recovery and manual logins must react at once instead of waiting out the interval.
        continue;
      }

      // Long pause after a run of scans so the rhythm is not a metronome.
      const pacing = this.#pacing();
      if (this.breakTarget <= 0) {
        this.breakTarget = randomBetween(pacing.breakEveryMin, pacing.breakEveryMax);
      }
      this.scansSinceBreak += 1;
      if (this.scansSinceBreak >= this.breakTarget) {
        const scannedCount = this.scansSinceBreak;
        this.scansSinceBreak = 0;
        this.breakTarget = randomBetween(pacing.breakEveryMin, pacing.breakEveryMax);
        const restMinutes = randomBetween(pacing.breakMinutesMin, pacing.breakMinutesMax);
        this.lastActivity = `已连续查询 ${scannedCount} 次，随机休息 ${restMinutes} 分钟（模拟人工停顿）。`;
        await this.#waitForLoop(restMinutes * 60_000);
      } else {
        await this.#waitForLoop(this.#nextScanDelay());
      }
    }
  }

  #nextScanDelay() {
    const pacing = this.#pacing();
    const factor = this.#observing() ? 2 : 1;
    return randomBetween(pacing.intervalMinSec * 1000 * factor, pacing.intervalMaxSec * 1000 * factor);
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

  #nextRule(rules, lastId = this.lastScannedRuleId) {
    if (!rules.length) {
      return null;
    }
    const index = rules.findIndex((rule) => rule.id === lastId);
    if (index === -1) {
      return rules[0];
    }
    return rules[(index + 1) % rules.length];
  }

  #ensureMachineRules() {
    const rules = this.database.listRules();
    if (rules.some((rule) => rule.kind === "machine")) {
      return;
    }
    const definitions = [
      { name: "【自动】整机·主机台式机", keyword: "主机 台式机" },
      { name: "【自动】整机·电脑整机", keyword: "电脑整机" }
    ];
    for (const definition of definitions) {
      this.database.createRule({
        name: definition.name,
        category: "custom",
        keyword: definition.keyword,
        includeTerms: [],
        excludeTerms: [],
        minPriceCny: null,
        maxPriceCny: 10_000,
        personalOnly: false,
        enabled: true,
        kind: "machine"
      });
    }
  }

  async #evaluateMachineListings(rule, listings, { baseline, generation }) {
    let hits = 0;
    let queued = 0;
    let alreadySeen = 0;
    let blocked = 0;
    let appraised = 0;
    for (const listing of listings) {
      if (generation !== this.scanGeneration) {
        break;
      }
      if (this.database.isListingBlocked(listing.itemId)) {
        blocked += 1;
        continue;
      }
      if (this.database.hasListing(rule.id, listing.itemId)) {
        alreadySeen += 1;
        continue;
      }
      const appraisal = typeof this.appraiser?.appraise === "function"
        ? this.appraiser.appraise(listing.title, listing.price)
        : null;
      appraised += 1;
      const hit = Boolean(appraisal && appraisal.inWindow === true && appraisal.kind === "machine");
      if (hit) {
        hits += 1;
      }
      const result = this.database.recordCandidateListing(
        rule,
        listing,
        listing.price,
        !baseline && hit,
        buildMachineMessage(listing, appraisal)
      );
      if (result.queued) {
        queued += 1;
      }
    }
    this.lastActivity = baseline
      ? `已建立基线：${rule.name}，记录 ${listings.length} 个结果。`
      : appraised
        ? `扫描完成：${rule.name}，估价 ${appraised} 个，窗口命中 ${hits} 个，新增提醒 ${queued} 个${alreadySeen ? `，已见 ${alreadySeen} 个` : ""}${blocked ? `，已屏蔽 ${blocked} 个` : ""}。`
        : `扫描完成：${rule.name}，没有新商品。`;
    return { scanned: true, baseline, listings: listings.length, matched: hits, alreadySeen, queued, blocked };
  }

  #pacing() {
    if (this.pacingCache && Date.now() - this.pacingCacheAt < 10_000) {
      return this.pacingCache;
    }
    let stored = null;
    try {
      stored = JSON.parse(this.database.getSetting("scan_pacing") ?? "null");
    } catch {
      stored = null;
    }
    this.pacingCache = normalizeScanPacing(stored ?? {});
    this.pacingCacheAt = Date.now();
    return this.pacingCache;
  }

  #observing() {
    const hours = this.#pacing().observationHours;
    if (!hours) {
      return false;
    }
    const last = Number(this.database.getSetting("last_verification_at") ?? 0);
    return Number.isFinite(last) && last > 0 && Date.now() - last < hours * 3_600_000;
  }

  #todayWindow() {
    const key = new Date().toDateString();
    if (this.windowCache?.key === key) {
      return this.windowCache;
    }
    const pacing = this.#pacing();
    const jitter = randomBetween(-pacing.windowJitterMinutes, pacing.windowJitterMinutes);
    const start = Math.min(1439, Math.max(0, parseTimeToMinutes(pacing.windowStart, 540) + jitter));
    const end = Math.min(1439, Math.max(start + 30, parseTimeToMinutes(pacing.windowEnd, 1380) + jitter));
    this.windowCache = { key, start, end };
    return this.windowCache;
  }

  #withinWindow() {
    const now = new Date();
    const minutes = now.getHours() * 60 + now.getMinutes();
    const window = this.#todayWindow();
    return minutes >= window.start && minutes < window.end;
  }

  #nextWindowStart() {
    const window = this.#todayWindow();
    const now = new Date();
    const minutes = now.getHours() * 60 + now.getMinutes();
    return { minutes: window.start, tomorrow: minutes >= window.start };
  }

  #msUntilWindowStart() {
    const window = this.#todayWindow();
    const now = new Date();
    const minutes = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
    const target = minutes < window.start ? window.start : 24 * 60 + window.start;
    return Math.max(60_000, Math.round((target - minutes) * 60_000));
  }

  #msUntilMidnight() {
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 1, 0);
    return Math.max(60_000, midnight.getTime() - now.getTime());
  }

  #scanCount(ruleId) {
    const day = new Date().toDateString();
    if (this.dailyScansDay !== day) {
      this.dailyScansDay = day;
      this.dailyScans = new Map();
    }
    return this.dailyScans.get(ruleId) ?? 0;
  }

  #isAccessPaused() {
    return this.accessPaused;
  }

  #canAutoRecover() {
    return this.autoRecoveryAttempts < 1 && typeof this.browser?.openLogin === "function";
  }

  async #pauseForAccess(kind) {
    const isNew = !this.accessPaused;
    this.accessPaused = true;
    this.accessPauseKind = kind === "login" ? "login" : "verification";
    if (!isNew) {
      this.lastActivity = this.#accessPauseMessage();
      return;
    }
    this.manualRecoveryNoticeSent = false;
    this.recoveryReportPending = false;
    if (this.manualLoginMode) {
      // The user is scanning a QR code in the window we just opened: keep it alive.
      this.accessRecoveryState = "manual_login";
      this.lastActivity = this.#accessPauseMessage();
      await this.#notifyAccessPause();
      return;
    }
    this.autoRecoveryAttempts = 0;
    this.verificationCooldownUntil = this.accessPauseKind === "verification"
      ? Date.now() + this.#pacing().cooldownMinutes * 60_000
      : 0;
    this.accessRecoveryState = "closing";
    this.lastActivity = this.#accessPauseMessage();
    if (typeof this.browser.close === "function") {
      try {
        await this.browser.close();
        this.accessRecoveryState = "closed";
      } catch {
        this.accessRecoveryState = "close_failed";
      }
    } else {
      this.accessRecoveryState = "close_failed";
    }
    this.lastActivity = this.#accessPauseMessage();
    await this.#notifyAccessPause();
  }

  async #awaitManualLogin() {
    let status = null;
    try {
      // The window is the user's workspace right now: never scan, navigate, close or switch it.
      status = await this.browser.verifyLogin({ openIfNeeded: false });
    } catch {
      // The window disappeared while checking; fall back to the regular scan loop.
      this.manualLoginMode = false;
      return;
    }
    if (!status.browserOpen) {
      // Closing a login window manually must not reopen it; wait for an explicit request.
      this.manualLoginMode = false;
      this.accessPaused = true;
      this.accessPauseKind = "login";
      this.accessRecoveryState = "closed_by_user";
      this.accessPauseNotified = false;
      this.manualRecoveryNoticeSent = false;
      this.recoveryReportPending = false;
      this.lastActivity = this.#accessPauseMessage();
      await this.#notifyAccessPause();
      return;
    }
    if (status.state === "verified") {
      this.manualLoginMode = false;
      this.lastActivity = "已确认扫码登录成功，继续按规则顺序查询。";
      return;
    }
    this.lastActivity = "等待扫码登录：登录窗口已保持打开，请直接在浏览器中扫码；登录成功后会自动继续查询。";
    await this.#waitForLoop(6_000);
  }

  async #recoverAccess() {
    return this.#withScanOperation(async () => {
      if (!this.running || !this.#isAccessPaused()) {
        return;
      }
      if (this.accessRecoveryState === "closed") {
        if (Date.now() < this.verificationCooldownUntil) {
          this.lastActivity = this.#accessPauseMessage();
          return;
        }
        if (!this.#canAutoRecover()) {
          this.accessRecoveryState = "manual";
          await this.#notifyManualRecovery();
          return;
        }
        await this.#openBrowser({ automatic: true }).catch(() => {});
        return;
      }
      if (this.accessRecoveryState === "checking" || this.accessRecoveryState === "manual_login") {
        await this.#checkAccessRecovery();
      }
    });
  }

  async #notifyManualRecovery() {
    if (this.manualRecoveryNoticeSent) {
      return;
    }
    this.manualRecoveryNoticeSent = true;
    await this.#sendStatusMessage(this.#accessPauseMessage());
  }

  async #openBrowser({ restart = false, automatic = false } = {}) {
    if (restart) {
      this.accessRecoveryState = "closing";
      try {
        await this.browser.close();
      } catch {
        this.accessRecoveryState = "close_failed";
        throw new Error("闲鱼浏览器关闭失败，请手动关闭监控窗口后重试。");
      }
    }
    if (automatic) {
      this.autoRecoveryAttempts += 1;
    }
    this.accessRecoveryState = "opening";
    try {
      await this.browser.openLogin();
    } catch {
      this.accessRecoveryState = "open_failed";
      throw new Error("闲鱼登录窗口打开失败，请点击“重新登录”重试。");
    }
    this.accessRecoveryState = "checking";
    await this.#checkAccessRecovery();
  }

  async #checkAccessRecovery() {
    if (!this.browser.status().browserOpen) {
      this.accessRecoveryState = "closed_by_user";
      return;
    }
    let status;
    try {
      status = await this.browser.verifyLogin({ openIfNeeded: false });
    } catch {
      this.accessRecoveryState = this.manualLoginMode ? "manual_login" : "checking";
      return;
    }
    if (status.state === "verified") {
      await this.#completeAccessRecovery({ automatic: true });
      return;
    }
    this.accessRecoveryState = this.manualLoginMode ? "manual_login" : "checking";
  }

  async #notifyAccessPause() {
    if (this.accessPauseNotified) {
      return;
    }
    this.accessPauseNotified = true;
    const followUp = this.manualLoginMode
      ? "登录窗口会保持打开，请直接在浏览器中扫码登录；确认有效后自动继续查询。"
      : this.accessPauseKind === "verification"
        ? `已进入冷却：${this.#pacing().cooldownMinutes} 分钟后自动尝试恢复一次（仅 1 次）；如果验证仍在，需要你人工完成（不会自动处理验证码）。`
        : "将复用已缓存的登录资料打开登录窗口一次；确认有效后自动继续查询，不会填写密码或处理验证码。";
    await this.#sendStatusMessage(`${this.#accessPauseMessage()}${followUp}`);
  }

  async #reportRecoveryScan(message) {
    if (!this.recoveryReportPending) {
      return;
    }
    this.recoveryReportPending = false;
    await this.#sendStatusMessage(message);
  }

  async #sendStatusMessage(message) {
    if (!this.notifier.configured()) {
      return false;
    }
    try {
      await this.notifier.sendMessage(`闲鱼硬件监控：${message}`);
      return true;
    } catch {
      // Listing alerts still use the retry queue; this is a one-shot status ping.
      return false;
    }
  }

  #accessPauseMessage() {
    const prefix = this.accessPauseKind === "login"
      ? "闲鱼登录已失效，自动查询已暂停。"
      : "闲鱼要求访问验证，自动查询已暂停。";
    let action;
    switch (this.accessRecoveryState) {
      case "closing":
        action = "正在关闭旧窗口。";
        break;
      case "closed":
        if (!this.running) {
          action = "旧窗口已关闭，监控未启动；点击“打开登录”或“重新登录”即可继续。";
        } else if (this.accessPauseKind === "verification" && Date.now() < this.verificationCooldownUntil) {
          const waitMinutes = Math.max(1, Math.ceil((this.verificationCooldownUntil - Date.now()) / 60_000));
          action = `验证冷却中：约 ${waitMinutes} 分钟后自动尝试恢复一次（仅 1 次）；若仍失败需要人工完成验证。`;
        } else {
          action = "即将自动打开登录窗口一次；确认登录有效后会自动继续查询。";
        }
        break;
      case "manual":
        action = "自动尝试已结束；请点击“打开登录”人工完成验证，确认有效后会自动继续查询。";
        break;
      case "opening":
        action = "正在打开登录窗口并确认登录。";
        break;
      case "manual_login":
        action = "登录窗口已保持打开，请直接在浏览器中扫码登录；确认有效后会自动继续查询，无需点击按钮。";
        break;
      case "checking":
        action = "登录窗口已打开，正在自动确认登录；有效后立即继续查询。如需人工登录或验证，完成后无需点击按钮。";
        break;
      case "closed_by_user":
        action = "浏览器窗口已手动关闭，不会自动重开；需要时点击“打开登录”。";
        break;
      case "close_failed":
        action = "旧窗口关闭失败，请手动关闭后点击“重新登录”。";
        break;
      case "open_failed":
        action = "登录窗口打开失败，请点击“重新登录”重试。";
        break;
      default:
        action = "等待登录确认；确认有效后会自动继续查询。";
    }
    return `${prefix}${action}`;
  }
}
