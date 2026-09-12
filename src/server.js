import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CATEGORIES } from "./categories.js";
import { splitTerms } from "./filter.js";
import { MonitorDatabase } from "./db.js";
import { AstrBotNotifier, normalizeAstrBotBaseUrl } from "./astrbot.js";
import { AiReviewer, normalizeAiBaseUrl } from "./ai.js";
import { XianyuBrowser } from "./browser.js";
import { MonitorService } from "./monitor.js";
import { MINIMUM_RULE_INTERVAL_SECONDS } from "./pacing.js";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const rootDirectory = resolve(sourceDirectory, "..");
const publicDirectory = resolve(rootDirectory, "public");
const dataDirectory = resolve(rootDirectory, "data");
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};
const categoryNames = new Set(CATEGORIES.map(([value]) => value));

function loadEnvironment() {
  const path = resolve(rootDirectory, ".env");
  if (!existsSync(path)) {
    return;
  }

  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[2].startsWith("#") || process.env[match[1]]) {
      continue;
    }
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}

function sendJson(response, status, payload) {
  const text = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text)
  });
  response.end(text);
}

function sendNoContent(response) {
  response.writeHead(204);
  response.end();
}

async function readJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 128_000) {
      throw new Error("请求内容过大");
    }
    chunks.push(chunk);
  }
  if (!chunks.length) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("请求 JSON 格式错误");
  }
}

function cleanText(value, field, maximumLength) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new Error(`${field}不能为空`);
  }
  if (text.length > maximumLength) {
    throw new Error(`${field}不能超过 ${maximumLength} 个字符`);
  }
  return text;
}

function cleanRule(input, current = {}) {
  const source = { ...current, ...input };
  const maximum = Number(source.maxPriceCny ?? source.priceCeilingCny);
  const hasMinimum = source.minPriceCny !== null && source.minPriceCny !== undefined && source.minPriceCny !== "";
  const minimum = hasMinimum ? Number(source.minPriceCny) : null;
  const interval = Number(source.scanIntervalSeconds);
  const category = String(source.category ?? "").trim();

  if (!categoryNames.has(category)) {
    throw new Error("请选择有效的硬件品类");
  }
  if (!Number.isFinite(maximum) || maximum <= 0 || maximum > 1_000_000) {
    throw new Error("最高价必须在 0 到 1,000,000 元之间");
  }
  if (minimum !== null && (!Number.isFinite(minimum) || minimum < 0 || minimum >= maximum)) {
    throw new Error("最低价必须大于等于 0 且小于最高价");
  }
  if (!Number.isInteger(interval) || interval < MINIMUM_RULE_INTERVAL_SECONDS || interval > 86_400) {
    throw new Error(`扫描间隔必须为 ${MINIMUM_RULE_INTERVAL_SECONDS} 到 86400 秒之间的整数`);
  }

  return {
    name: cleanText(source.name, "规则名称", 80),
    category,
    keyword: cleanText(source.keyword, "搜索词", 120),
    includeTerms: splitTerms(source.includeTerms),
    excludeTerms: splitTerms(source.excludeTerms),
    minPriceCny: minimum,
    maxPriceCny: maximum,
    personalOnly: Boolean(source.personalOnly),
    enabled: source.enabled !== false,
    scanIntervalSeconds: interval
  };
}

function staticFile(requestPath, response) {
  const requested = requestPath === "/" ? "/index.html" : requestPath;
  const path = resolve(publicDirectory, `.${requested}`);
  if (!path.startsWith(`${publicDirectory}\\`) && path !== publicDirectory) {
    sendJson(response, 403, { error: "禁止访问该文件" });
    return;
  }
  if (!existsSync(path)) {
    sendJson(response, 404, { error: "未找到资源" });
    return;
  }

  const data = readFileSync(path);
  response.writeHead(200, {
    "content-type": mimeTypes[extname(path)] ?? "application/octet-stream",
    "cache-control": "no-cache"
  });
  response.end(data);
}

function apiError(response, error) {
  const message = error instanceof Error ? error.message : "服务器发生未知错误";
  sendJson(response, 400, { error: message });
}

async function routeApi(request, response, url, services) {
  const { database, monitor, browser, notifier } = services;
  const path = url.pathname;
  const method = request.method ?? "GET";

  if (method === "GET" && path === "/api/status") {
    return sendJson(response, 200, monitor.status());
  }
  if (method === "GET" && path === "/api/categories") {
    return sendJson(response, 200, CATEGORIES.map(([value, label]) => ({ value, label })));
  }
  if (method === "GET" && path === "/api/rules") {
    return sendJson(response, 200, database.listRules());
  }
  if (method === "POST" && path === "/api/rules") {
    const body = await readJson(request);
    return sendJson(response, 201, database.createRule(cleanRule(body)));
  }

  const ruleMatch = path.match(/^\/api\/rules\/(\d+)$/);
  if (ruleMatch && method === "PUT") {
    const current = database.getRule(Number(ruleMatch[1]));
    if (!current) {
      return sendJson(response, 404, { error: "未找到该规则" });
    }
    const body = await readJson(request);
    return sendJson(response, 200, database.updateRule(current.id, cleanRule(body, current)));
  }
  if (ruleMatch && method === "DELETE") {
    return database.deleteRule(Number(ruleMatch[1]))
      ? sendNoContent(response)
      : sendJson(response, 404, { error: "未找到该规则" });
  }

  const scanMatch = path.match(/^\/api\/rules\/(\d+)\/scan$/);
  if (scanMatch && method === "POST") {
    return sendJson(response, 200, await monitor.scanNow(Number(scanMatch[1])));
  }

  if (method === "POST" && path === "/api/monitor/start") {
    return sendJson(response, 200, monitor.start());
  }
  if (method === "POST" && path === "/api/monitor/stop") {
    return sendJson(response, 200, await monitor.stop());
  }
  if (method === "POST" && path === "/api/monitor/resume") {
    return sendJson(response, 200, await monitor.resumeAfterHumanCheck());
  }
  if (method === "GET" && path === "/api/listings") {
    return sendJson(response, 200, database.listListings(url.searchParams.get("limit")));
  }
  if (method === "GET" && path === "/api/blocked-listings") {
    return sendJson(response, 200, database.listBlockedListings(url.searchParams.get("limit")));
  }
  if (method === "POST" && path === "/api/blocked-listings") {
    const body = await readJson(request);
    const itemId = cleanText(body.itemId, "商品 ID", 200);
    const title = cleanText(body.title, "商品标题", 500);
    const listingUrl = cleanText(body.url, "商品链接", 1_000);
    if (!/^https?:\/\//i.test(listingUrl)) {
      throw new Error("商品链接格式无效");
    }
    return sendJson(response, 201, database.blockListing({
      itemId,
      title,
      url: listingUrl,
      sellerName: String(body.sellerName ?? "").slice(0, 200)
    }));
  }
  const blockedMatch = path.match(/^\/api\/blocked-listings\/([^/]+)$/);
  if (blockedMatch && method === "DELETE") {
    const itemId = decodeURIComponent(blockedMatch[1]);
    return database.unblockListing(itemId)
      ? sendNoContent(response)
      : sendJson(response, 404, { error: "未找到屏蔽商品" });
  }
  if (method === "GET" && path === "/api/notifications") {
    return sendJson(response, 200, database.listNotifications(url.searchParams.get("limit")));
  }
  if (method === "POST" && path === "/api/notifications/retry-failed") {
    return sendJson(response, 200, { retried: database.retryFailedNotifications() });
  }
  if (method === "GET" && path === "/api/settings") {
    return sendJson(response, 200, database.getPublicSettings());
  }
  if (method === "PUT" && path === "/api/settings") {
    const body = await readJson(request);
    const currentSettings = database.getPublicSettings();
    const receiver = body.astrbotReceiverQq === undefined
      ? currentSettings.astrbotReceiverQq
      : String(body.astrbotReceiverQq).trim();
    const botId = body.astrbotBotId === undefined
      ? currentSettings.astrbotBotId
      : String(body.astrbotBotId).trim();
    if (receiver && !/^\d{5,15}$/.test(receiver)) {
      throw new Error("接收 QQ 号格式无效");
    }
    if (botId && (botId.length > 100 || /[\s:]/.test(botId))) {
      throw new Error("AstrBot 机器人 ID 不能包含空格或冒号");
    }
    const aiBaseUrl = String(body.aiBaseUrl ?? "").trim();
    const aiModel = String(body.aiModel ?? "").trim();
    if (aiBaseUrl) {
      normalizeAiBaseUrl(aiBaseUrl);
    }
    if (aiModel.length > 120) {
      throw new Error("AI 模型名称不能超过 120 个字符");
    }
    return sendJson(response, 200, database.updateSettings({
      astrbotBaseUrl: normalizeAstrBotBaseUrl(body.astrbotBaseUrl ?? currentSettings.astrbotBaseUrl),
      astrbotApiKey: body.astrbotApiKey,
      astrbotBotId: botId,
      astrbotReceiverQq: receiver,
      aiEnabled: typeof body.aiEnabled === "boolean" ? body.aiEnabled : undefined,
      aiBaseUrl: aiBaseUrl || undefined,
      aiApiKey: body.aiApiKey,
      aiModel: aiModel || undefined
    }));
  }
  if (method === "POST" && path === "/api/settings/test-astrbot") {
    await notifier.sendMessage("闲鱼硬件监控：AstrBot + NapCat QQ 提醒测试成功。");
    return sendJson(response, 200, { ok: true });
  }
  if (method === "POST" && path === "/api/settings/test-ai") {
    if (!services.ai.configured()) {
      throw new Error("请先启用 AI 并保存接口地址和模型名称");
    }
    const result = await services.ai.reviewCandidates(
      {
        name: "连接测试",
        category: "custom",
        keyword: "硬件",
        includeTerms: [],
        excludeTerms: [],
        minPriceCny: null,
        maxPriceCny: 1_000_000
      },
      [{
        itemId: "ai-connection-test",
        title: "测试用二手显卡",
        price: 999,
        sellerName: "测试",
        url: "https://www.goofish.com/item?id=ai-connection-test"
      }]
    );
    if (result.error) {
      throw new Error(result.error);
    }
    return sendJson(response, 200, { ok: true, reviewed: result.decisions.size });
  }
  if (method === "GET" && path === "/api/browser") {
    return sendJson(response, 200, browser.status());
  }
  if (method === "POST" && path === "/api/browser/login") {
    return sendJson(response, 200, await browser.openLogin());
  }
  if (method === "POST" && path === "/api/browser/verify") {
    return sendJson(response, 200, await browser.verifyLogin());
  }
  if (method === "POST" && path === "/api/browser/close") {
    return sendJson(response, 200, await browser.close());
  }

  sendJson(response, 404, { error: "未找到 API" });
}

export function createApplication({ databasePath = resolve(dataDirectory, "monitor.sqlite") } = {}) {
  loadEnvironment();
  const database = new MonitorDatabase(databasePath);
  database.initializeFromEnvironment(process.env);
  const browser = new XianyuBrowser({ dataDirectory: dirname(databasePath) });
  const notifier = new AstrBotNotifier(database);
  const ai = new AiReviewer(database);
  const monitor = new MonitorService({ database, browser, notifier, ai });
  const services = { database, browser, notifier, ai, monitor };

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname.startsWith("/api/")) {
        await routeApi(request, response, url, services);
      } else {
        staticFile(url.pathname, response);
      }
    } catch (error) {
      apiError(response, error);
    }
  });

  return {
    server,
    services,
    async close() {
      await monitor.stop();
      await browser.close().catch(() => {});
      database.close();
    }
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 8788;
  const app = createApplication();
  app.server.listen(port, "127.0.0.1", () => {
    console.log(`闲鱼硬件监控已启动：http://127.0.0.1:${port}`);
  });

  const shutdown = async () => {
    await app.close();
    app.server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
