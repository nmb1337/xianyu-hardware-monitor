import { categoryLabel } from "./categories.js";
import { evaluateListing } from "./filter.js";

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
  constructor({ database, browser, notifier, ai = null }) {
    this.database = database;
    this.browser = browser;
    this.notifier = notifier;
    this.ai = ai;
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
    this.autoRecoveryStreak = 0;
    this.lastAutoSwitchBrowser = "";
    this.recoveryReportPending = false;
    this.scanOperation = Promise.resolve();
    this.scanGeneration = 0;
    this.restartLoginPromise = null;
    // True while the user is expected to scan a QR code in the login window we opened.
    this.manualLoginMode = false;
  }

  status() {
    const paused = this.#isAccessPaused();
    const enabledRules = this.database.listRules().filter((rule) => rule.enabled);
    const nextRule = this.#nextRule(enabledRules);
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
      lastScannedRuleId: this.lastScannedRuleId
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
      : "监控已启动，将按规则顺序连续查询。";
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

    this.activeRuleId = rule.id;
    const generation = this.scanGeneration;
    this.lastActivity = `正在扫描：${rule.name}`;
    let errorMessage = null;
    const baseline = !rule.lastScannedAt;
    try {
      const listings = await this.browser.scan(rule);
      this.autoRecoveryStreak = 0;
      this.manualLoginMode = false;
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
    this.manualLoginMode = false;
    this.accessPaused = false;
    this.accessPauseKind = "";
    this.accessRecoveryState = "none";
    this.accessPauseNotified = false;
    this.manualRecoveryNoticeSent = false;
    this.recoveryReportPending = true;
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

      const rules = this.database.enabledRulesInOrder();
      if (!rules.length) {
        this.lastActivity = "没有已启用的规则，等待添加。";
        await this.#waitForLoop(15_000);
        continue;
      }

      const rule = this.#nextRule(rules);
      try {
        await this.scanRule(rule);
      } catch {
        // The failure is recorded on the rule; keep the rotation moving.
      } finally {
        this.lastScannedRuleId = rule.id;
      }
      await this.notifier.processOne();
      // Yield to the event loop so even instant failures cannot starve the process.
      await new Promise((resolve) => setImmediate(resolve));
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

  #nextRule(rules) {
    if (!rules.length) {
      return null;
    }
    const index = rules.findIndex((rule) => rule.id === this.lastScannedRuleId);
    if (index === -1) {
      return rules[0];
    }
    return rules[(index + 1) % rules.length];
  }

  #isAccessPaused() {
    return this.accessPaused;
  }

  #canAutoRecover() {
    return this.autoRecoveryStreak < 2 && typeof this.browser?.openLogin === "function";
  }

  #canAutoSwitch() {
    if (!this.#canAutoRecover()) {
      return false;
    }
    if (typeof this.browser?.switchBrowser !== "function") {
      return false;
    }
    const status = this.browser.status();
    return Boolean(status.canSwitch && status.alternateBrowserName);
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
      if (this.#canAutoSwitch()) {
        try {
          await this.browser.switchBrowser();
        } catch {
          this.accessRecoveryState = "switch_failed";
          throw new Error("备用浏览器切换失败，请点击“重新登录”重试。");
        }
        this.lastAutoSwitchBrowser = this.browser.status().browserName;
        this.lastActivity = `已自动切换到 ${this.lastAutoSwitchBrowser}，正在确认登录。`;
      }
      this.autoRecoveryStreak += 1;
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
      : this.#canAutoSwitch()
        ? `即将自动切换到 ${this.browser.status().alternateBrowserName} 并确认缓存登录；确认有效后自动继续查询，不会填写密码或处理验证码。`
        : "将复用已缓存的登录资料；不会填写密码或处理验证码。";
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
    const target = this.#canAutoSwitch() ? this.browser.status().alternateBrowserName : "";
    let action;
    switch (this.accessRecoveryState) {
      case "closing":
        action = "正在关闭旧窗口。";
        break;
      case "closed":
        action = !this.running
          ? "旧窗口已关闭，监控未启动；点击“打开登录”或“重新登录”即可继续。"
          : target
            ? `旧窗口已关闭，即将自动切换到 ${target} 并打开登录窗口；确认登录有效后会自动继续查询。`
            : "旧窗口已关闭，即将自动打开登录窗口；确认登录有效后会自动继续查询。";
        break;
      case "switch_failed":
        action = "备用浏览器切换失败，请点击“重新登录”重试。";
        break;
      case "manual":
        action = "访问验证连续出现，已停止自动切换窗口；请点击“打开登录”人工完成验证，确认有效后会自动继续查询。";
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
