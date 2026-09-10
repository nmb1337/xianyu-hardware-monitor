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

function looksLikeLoginOrVerification(url, text) {
  const source = `${url}\n${text}`.toLowerCase();
  return /passport|mini_login|login\.taobao|sec\.taobao|captcha|x5sec|安全验证|滑块|请先登录|扫码登录|访问异常|操作过于频繁/.test(
    source
  );
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
  return /baxia-dialog(?:-mask)?|intercepts pointer events/i.test(
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
        const usablePage = pages.find((page) => !page.isClosed());
        this.page = usablePage ?? (await this.context.newPage());
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
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
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

  async #hasVerificationMask() {
    return this.page
      .locator(VERIFICATION_MASK_SELECTOR)
      .first()
      .isVisible({ timeout: 1_000 })
      .catch(() => false);
  }

  async #requireManualVerification() {
    this.loginState = "waiting_for_verification";
    this.message = "闲鱼弹出了访问验证，请在浏览器窗口中人工完成后再扫描。";
    await this.page.bringToFront();
    throw new Error(this.message);
  }

  async #checkForManualVerification(pageText = "") {
    if (
      looksLikeLoginOrVerification(this.page.url, pageText.slice(0, 20_000))
      || await this.#hasVerificationMask()
    ) {
      await this.#requireManualVerification();
    }
  }

  async #waitForSearchSlot() {
    const waitMilliseconds = this.lastSearchStartedAt + MINIMUM_SEARCH_GAP_MS - Date.now();
    if (waitMilliseconds > 0) {
      this.message = `访问频率保护：将在 ${Math.ceil(waitMilliseconds / 1_000)} 秒后执行下一次搜索。`;
      await this.page.waitForTimeout(waitMilliseconds);
    }
    this.lastSearchStartedAt = Date.now();
  }

  async #clickSortOption(text) {
    try {
      await this.page
        .getByText(text, { exact: true })
        .first()
        .click({ timeout: 8_000 });
    } catch (error) {
      if (isVerificationOverlayError(error) || await this.#hasVerificationMask()) {
        await this.#requireManualVerification();
      }
      throw error;
    }
  }

  async #withOperation(callback) {
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
          if (attempt === 0 && isClosedTargetError(error)) {
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
      this.loginState = "waiting_for_login";
      this.message = "请在已打开的浏览器中完成闲鱼登录。";
      await this.page.goto("https://www.goofish.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
      await this.page.bringToFront();
      return this.status();
    });
  }

  async verifyLogin() {
    return this.#withOperation(async () => {
      await this.#ensureContext();
      const cookies = await this.context.cookies("https://www.goofish.com/");
      const hasCookie = cookies.some(
        (cookie) => LOGIN_COOKIE_NAMES.has(cookie.name) && Boolean(cookie.value)
      );
      const pageText = await this.page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");

      const hasVerificationMask = await this.#hasVerificationMask();
      if (
        hasCookie
        && !hasVerificationMask
        && !looksLikeLoginOrVerification(this.page.url, pageText.slice(0, 8_000))
      ) {
        this.loginState = "verified";
        this.message = "闲鱼登录状态已验证。";
      } else {
        this.loginState = hasVerificationMask ? "waiting_for_verification" : "waiting_for_login";
        this.message = hasVerificationMask
          ? "闲鱼仍在要求访问验证，请在浏览器窗口中人工完成。"
          : "未检测到有效登录状态，请在浏览器中完成登录或验证。";
        if (hasVerificationMask) {
          await this.page.bringToFront();
        }
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
      const url = `${SEARCH_URL}${encodeURIComponent(rule.keyword)}`;
      await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await this.page.waitForTimeout(3_500);

      const pageText = await this.page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
      await this.#checkForManualVerification(pageText);

      await this.#clickSortOption("新发布");
      await this.page.waitForTimeout(600);
      await this.#checkForManualVerification();

      const latestResponse = this.page.waitForResponse(isSearchResponse, { timeout: 30_000 });
      await this.#clickSortOption("最新");
      const payload = await (await latestResponse).json();
      const listings = parseSearchResponse(payload);
      if (!listings.length) {
        throw new Error("闲鱼搜索接口未返回可识别的商品价格，本轮不会发送提醒。");
      }

      this.loginState = "verified";
      this.message = listings.length
        ? `已读取 ${listings.length} 个搜索结果。`
        : "未读取到商品卡片，可能需要刷新页面或人工完成验证。";
      return listings.slice(0, 30);
    });
  }

}
