import { existsSync, mkdirSync } from "node:fs";
import { URL } from "node:url";
import { resolve } from "node:path";
import { parsePrice } from "./filter.js";
import { MINIMUM_SEARCH_GAP_MS } from "./pacing.js";

const SEARCH_URL = "https://www.goofish.com/search?q=";
const LOGIN_COOKIE_NAMES = new Set(["tracknick", "unb", "lgc"]);
const SEARCH_RESPONSE_MARKER = "mtop.taobao.idlemtopsearch.pc.search";
const VERIFICATION_MASK_SELECTOR = ".baxia-dialog-mask";

function chromeExecutable() {
  const candidates = [
    process.env.XIANYU_BROWSER_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
  ].filter(Boolean);

  return candidates.find((path) => existsSync(path)) ?? null;
}

function normalizeUrl(value) {
  if (!value) {
    return "";
  }
  if (value.startsWith("//")) {
    return `https:${value}`;
  }
  if (value.startsWith("/")) {
    return `https://www.goofish.com${value}`;
  }
  return value;
}

function accessKindFromUrl(value) {
  try {
    const url = new URL(value);
    const location = `${url.hostname}${url.pathname}`;
    if (/sec\.taobao|captcha|x5sec|punish/i.test(location) || url.searchParams.has("x5sec")) {
      return "verification";
    }
    if (/passport|mini_login|login\.taobao/i.test(location)) {
      return "login";
    }
  } catch {
    // Blank or closed tabs do not provide evidence of a valid session.
  }
  return null;
}

function isXianyuUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && /(^|\.)goofish\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
}

function accessKindFromText(text) {
  if (/安全验证|滑块|访问验证|访问异常|操作过于频繁|请完成验证/.test(text)) {
    return "verification";
  }
  return /请先登录|扫码登录|登录已失效/.test(text) ? "login" : null;
}

function accessKindFromResponse(payload) {
  const ret = asObject(payload).ret;
  const codes = (Array.isArray(ret) ? ret : [ret]).join(" ");
  if (/USER_VALIDATE|RGV587|FLOW_LIMIT|ACCESS_DENIED/i.test(codes)) {
    return "verification";
  }
  if (/SESSION_EXPIRED|TOKEN_EXPIRED|TOKEN_EMPTY|NEED_LOGIN|ILLEGAL_ACCESS/i.test(codes)) {
    return "login";
  }
  return accessKindFromText(codes);
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function firstValue(...values) {
  return values.find((value) => value !== null && value !== undefined && value !== "") ?? "";
}

function firstText(...values) {
  return values.map((value) => String(value ?? "").trim()).find(Boolean) ?? "";
}

export function parseSearchResponse(payload) {
  const data = asObject(asObject(payload).data);
  const resultList = data.resultList;
  if (!Array.isArray(resultList)) {
    return [];
  }

  const seen = new Set();
  const listings = [];
  for (const element of resultList) {
    const main = asObject(asObject(asObject(asObject(element).data).item).main);
    const content = asObject(main.exContent);
    const detail = asObject(content.detailParams);
    const args = asObject(asObject(main.clickParam).args);
    const itemId = String(
      firstValue(content.itemId, detail.itemId, args.item_id, args.itemId)
    ).trim();
    const title = String(firstValue(content.title, detail.title, args.title)).trim();
    const price = parsePrice(
      firstValue(detail.soldPrice, args.price, args.displayPrice, content.price)
    );

    if (!itemId || !title || price === null || seen.has(itemId)) {
      continue;
    }

    seen.add(itemId);
    listings.push({
      itemId,
      title,
      price,
      url: `https://www.goofish.com/item?id=${encodeURIComponent(itemId)}`,
      sellerName: firstText(
        content.userNick,
        content.sellerNick,
        content.nickName,
        detail.userNick,
        detail.sellerNick,
        args.userNick,
        args.sellerNick
      ),
      // The search response does not expose a stable personal/business flag.
      // Keep the item and rely on explicit exclude terms until a seller-profile
      // review is added.
      isPersonal: true
    });
  }
  return listings;
}

function isSearchResponse(response) {
  return response.url().toLowerCase().includes(SEARCH_RESPONSE_MARKER);
}

export function isClosedTargetError(error) {
  return /target page, context or browser has been closed|browser has been closed|target closed/i.test(
    String(error instanceof Error ? error.message : error)
  );
}

export function isVerificationOverlayError(error) {
  return /baxia-dialog(?:-mask)?/i.test(
    String(error instanceof Error ? error.message : error)
  );
}

export class XianyuBrowser {
  constructor({ dataDirectory }) {
    this.profileDirectory = resolve(dataDirectory, "chrome-profile");
    this.executablePath = chromeExecutable();
    this.context = null;
    this.page = null;
    this.playwright = null;
    this.loginState = "not_started";
    this.message = "";
    this.operation = Promise.resolve();
    this.lastSearchStartedAt = 0;
  }

  status() {
    return {
      available: Boolean(this.executablePath),
      executablePath: this.executablePath ?? "",
      state: this.loginState,
      message: this.message,
      browserOpen: Boolean(this.context)
    };
  }

  async #loadPlaywright() {
    if (this.playwright) {
      return this.playwright;
    }
    try {
      const module = await import("playwright-core");
      this.playwright = module.chromium;
      return this.playwright;
    } catch {
      throw new Error("浏览器自动化组件未安装。请在项目目录运行 pnpm install。");
    }
  }

  async #ensureContext() {
    if (this.context) {
      try {
        const pages = this.context.pages();
        const usablePages = pages.filter((page) => !page.isClosed());
        const relevant = (page) => isXianyuUrl(page.url()) || accessKindFromUrl(page.url());
        this.page = (usablePages.includes(this.page) && relevant(this.page) ? this.page : null)
          ?? usablePages.find(relevant)
          ?? (usablePages.includes(this.page) ? this.page : usablePages[0])
          ?? (await this.context.newPage());
        return this.context;
      } catch {
        await this.#discardContext();
      }
    }
    if (!this.executablePath) {
      throw new Error("未找到 Chrome 或 Edge。可通过 XIANYU_BROWSER_PATH 指定浏览器路径。");
    }

    const chromium = await this.#loadPlaywright();
    mkdirSync(this.profileDirectory, { recursive: true });
    this.context = await chromium.launchPersistentContext(this.profileDirectory, {
      executablePath: this.executablePath,
      headless: false,
      viewport: null,
      args: ["--start-maximized"]
    });
    this.context.on("close", () => {
      this.context = null;
      this.page = null;
      if (this.loginState !== "verified") {
        this.loginState = "not_started";
      }
    });
    this.page = this.context.pages().find((page) => isXianyuUrl(page.url()) || accessKindFromUrl(page.url()))
      ?? this.context.pages()[0]
      ?? (await this.context.newPage());
    return this.context;
  }

  async #discardContext() {
    const context = this.context;
    this.context = null;
    this.page = null;
    if (context) {
      await context.close().catch(() => {});
    }
  }

  async #isFrameVisible(frame) {
    for (let current = frame; current.parentFrame(); current = current.parentFrame()) {
      const element = await current.frameElement();
      try {
        if (!await element.isVisible()) {
          return false;
        }
      } finally {
        await element.dispose();
      }
    }
    return true;
  }

  async #inspectPageAccess(page) {
    const urlKind = accessKindFromUrl(page.url());
    if (urlKind) {
      return { kind: urlKind, page };
    }
    let hasContent = false;
    let login = null;
    for (const frame of page.frames()) {
      try {
        if (!await this.#isFrameVisible(frame)) {
          continue;
        }
        let kind = accessKindFromUrl(frame.url());
        if (await frame.locator(VERIFICATION_MASK_SELECTOR).filter({ visible: true }).count()) {
          kind = "verification";
        }
        if (!kind) {
          const text = await frame.locator("body").innerText({ timeout: 5_000 });
          if (frame === page.mainFrame()) {
            hasContent = Boolean(text.trim());
          }
          kind = accessKindFromText(text.slice(0, 20_000));
        }
        if (kind === "verification") {
          return { kind, page };
        }
        if (kind === "login") {
          login = { kind, page };
        }
      } catch (error) {
        if (isClosedTargetError(error)) {
          throw error;
        }
        if (frame.isDetached()) {
          continue;
        }
        // An unreadable visible frame must not be mistaken for a cleared challenge.
        return { kind: "verification", page };
      }
    }
    return login ?? { kind: null, page, hasContent };
  }

  async #findAccessBlock() {
    const pages = [this.page, ...this.context.pages().filter((page) =>
      page !== this.page && !page.isClosed()
      && (isXianyuUrl(page.url()) || accessKindFromUrl(page.url()))
    )];
    let login = null;
    for (const page of pages) {
      const access = await this.#inspectPageAccess(page);
      if (access.kind === "verification") {
        return access;
      }
      if (access.kind === "login") {
        login = access;
      }
    }
    return login;
  }

  async #showAccessBlock({ kind, page = this.page }) {
    this.page = page;
    this.loginState = kind === "login" ? "waiting_for_login" : "waiting_for_verification";
    this.message = kind === "login"
      ? "闲鱼登录已失效，请在浏览器窗口中完成登录后再恢复扫描。"
      : "闲鱼要求访问验证，请在浏览器窗口中人工完成后再恢复扫描。";
    await page.bringToFront().catch(() => {});
  }

  async #requireAccessCheck(access) {
    await this.#showAccessBlock(access);
    throw new Error(this.message);
  }

  async #checkForManualVerification() {
    const access = await this.#findAccessBlock();
    if (access) {
      await this.#requireAccessCheck(access);
    }
  }

  async #waitForSearchSlot() {
    const waitMilliseconds = this.lastSearchStartedAt + MINIMUM_SEARCH_GAP_MS - Date.now();
    if (waitMilliseconds > 0) {
      this.message = `访问频率保护：将在 ${Math.ceil(waitMilliseconds / 1_000)} 秒后执行下一次搜索。`;
      await this.page.waitForTimeout(waitMilliseconds);
    }
  }

  async #clickSortOption(text) {
    try {
      await this.page
        .getByText(text, { exact: true })
        .filter({ visible: true })
        .first()
        .click({ timeout: 8_000 });
    } catch (error) {
      if (isVerificationOverlayError(error)) {
        await this.#requireAccessCheck({ kind: "verification" });
      }
      await this.#checkForManualVerification();
      throw error;
    }
  }

  async #readLatestResponse() {
    const page = this.page;
    let onResponse;
    let onClose;
    let timer;
    const response = new Promise((resolve, reject) => {
      onResponse = (value) => {
        if (isSearchResponse(value)) {
          resolve(value);
        }
      };
      onClose = () => reject(new Error("Target page, context or browser has been closed"));
      page.on("response", onResponse);
      page.on("close", onClose);
      timer = setTimeout(() => reject(new Error("等待闲鱼搜索结果超时。")), 30_000);
    });
    try {
      const [result] = await Promise.all([response, this.#clickSortOption("最新")]);
      return result;
    } finally {
      clearTimeout(timer);
      page.removeListener("response", onResponse);
      page.removeListener("close", onClose);
    }
  }

  async #withOperation(callback, { retryClosed = true } = {}) {
    const previous = this.operation;
    let release;
    this.operation = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          return await callback();
        } catch (error) {
          if (!retryClosed && isClosedTargetError(error)) {
            this.loginState = "waiting_for_login";
            this.message = "监控浏览器已关闭，本轮搜索已停止，请重新打开登录窗口后手动恢复。";
            throw new Error(this.message, { cause: error });
          }
          if (retryClosed && attempt === 0 && isClosedTargetError(error)) {
            await this.#discardContext();
            this.loginState = "not_started";
            this.message = "浏览器会话已关闭，正在重新打开。";
            continue;
          }
          throw error;
        }
      }
    } finally {
      release();
    }
  }

  async openLogin() {
    return this.#withOperation(async () => {
      await this.#ensureContext();
      const access = await this.#findAccessBlock();
      if (access) {
        await this.#showAccessBlock(access);
        return this.status();
      }
      this.loginState = "waiting_for_login";
      this.message = "请在已打开的浏览器中完成闲鱼登录。";
      if (!isXianyuUrl(this.page.url())) {
        await this.page.goto("https://www.goofish.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
      }
      await this.page.bringToFront();
      return this.status();
    });
  }

  async verifyLogin() {
    return this.#withOperation(async () => {
      await this.#ensureContext();
      const access = await this.#findAccessBlock();
      if (access) {
        await this.#showAccessBlock(access);
        return this.status();
      }
      const cookies = await this.context.cookies("https://www.goofish.com/");
      const hasCookie = cookies.some(
        (cookie) => LOGIN_COOKIE_NAMES.has(cookie.name) && Boolean(cookie.value)
      );
      const current = await this.#inspectPageAccess(this.page);
      if (
        hasCookie
        && !current.kind
        && current.hasContent
        && isXianyuUrl(this.page.url())
      ) {
        this.loginState = "verified";
        this.message = "闲鱼登录状态已验证。";
      } else if (current.kind) {
        await this.#showAccessBlock(current);
      } else {
        this.loginState = "waiting_for_login";
        this.message = "未检测到有效闲鱼登录页面，请在浏览器中完成登录或验证。";
      }
      return this.status();
    });
  }

  async close() {
    return this.#withOperation(async () => {
      await this.#discardContext();
      this.loginState = "not_started";
      this.message = "浏览器已关闭。";
      return this.status();
    });
  }

  async scan(rule) {
    return this.#withOperation(async () => {
      await this.#ensureContext();
      await this.#checkForManualVerification();

      const cookies = await this.context.cookies("https://www.goofish.com/");
      const hasCookie = cookies.some(
        (cookie) => LOGIN_COOKIE_NAMES.has(cookie.name) && Boolean(cookie.value)
      );
      if (!hasCookie) {
        this.loginState = "waiting_for_login";
        this.message = "需要在浏览器中登录闲鱼后才能扫描。";
        await this.page.goto("https://www.goofish.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
        await this.page.bringToFront();
        throw new Error(this.message);
      }

      await this.#waitForSearchSlot();
      await this.#checkForManualVerification();
      const url = `${SEARCH_URL}${encodeURIComponent(rule.keyword)}`;
      this.lastSearchStartedAt = Date.now();
      await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await this.page.waitForTimeout(3_500);

      await this.#checkForManualVerification();

      await this.#clickSortOption("新发布");
      await this.page.waitForTimeout(600);
      await this.#checkForManualVerification();

      let response;
      try {
        response = await this.#readLatestResponse();
      } catch (error) {
        await this.#checkForManualVerification();
        throw error;
      }
      await this.#checkForManualVerification();
      if ([401, 403, 429].includes(response.status())) {
        await this.#requireAccessCheck({ kind: response.status() === 401 ? "login" : "verification" });
      }
      if (!response.ok()) {
        throw new Error(`闲鱼搜索接口返回 HTTP ${response.status()}，本轮不会发送提醒。`);
      }
      const payload = await response.json();
      const accessKind = accessKindFromResponse(payload);
      if (accessKind) {
        await this.#requireAccessCheck({ kind: accessKind });
      }
      await this.#checkForManualVerification();
      const listings = parseSearchResponse(payload);
      if (!listings.length) {
        throw new Error("闲鱼搜索接口未返回可识别的商品价格，本轮不会发送提醒。");
      }

      this.loginState = "verified";
      this.message = listings.length
        ? `已读取 ${listings.length} 个搜索结果。`
        : "未读取到商品卡片，可能需要刷新页面或人工完成验证。";
      return listings.slice(0, 30);
    }, { retryClosed: false });
  }

}
