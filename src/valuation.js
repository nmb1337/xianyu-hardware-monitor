import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = resolve(
  projectDirectory,
  process.env.XIANYU_VALUATION_CATALOG_PATH || "data/valuation-catalog.json"
);
const EMPTY_CATALOG = {
  version: "missing-local-catalog",
  sourceDate: null,
  hostCapCny: 5_500,
  tolerancePercent: 15,
  motherboardDefaultCny: 50,
  storagePricesCny: { "256g": 100, "512g": 200, "1tb": 400 },
  cpu: [],
  gpu: [],
  memory: []
};

function loadCatalog() {
  if (!existsSync(catalogPath)) return EMPTY_CATALOG;
  try {
    const parsed = JSON.parse(readFileSync(catalogPath, "utf8"));
    return {
      ...EMPTY_CATALOG,
      ...parsed,
      cpu: Array.isArray(parsed.cpu) ? parsed.cpu : [],
      gpu: Array.isArray(parsed.gpu) ? parsed.gpu : [],
      memory: Array.isArray(parsed.memory) ? parsed.memory : [],
      storagePricesCny: { ...EMPTY_CATALOG.storagePricesCny, ...(parsed.storagePricesCny ?? {}) }
    };
  } catch {
    return EMPTY_CATALOG;
  }
}

const CATALOG = loadCatalog();
const PRICE_TABLE_VERSION = String(CATALOG.version);

export const VALUATION_DEFAULTS = Object.freeze({
  hostCapCny: Number.isFinite(Number(CATALOG.hostCapCny)) && Number(CATALOG.hostCapCny) > 0
    ? Number(CATALOG.hostCapCny)
    : 5_500,
  tolerancePercent: Math.min(
    100,
    Math.max(
      0,
      Number.isFinite(Number(CATALOG.tolerancePercent)) ? Number(CATALOG.tolerancePercent) : 15
    )
  ),
  motherboardDefaultCny: Number.isFinite(Number(CATALOG.motherboardDefaultCny))
    && Number(CATALOG.motherboardDefaultCny) >= 0
    ? Number(CATALOG.motherboardDefaultCny)
    : 50,
  storagePricesCny: Object.fromEntries(
    Object.entries(CATALOG.storagePricesCny)
      .map(([key, value]) => [key, Number(value)])
      .filter(([, value]) => Number.isFinite(value) && value >= 0)
  )
});

// Entries are deliberately limited to values that can be read reliably from the
// supplied recycle-price sheets. Unknown models stay visible but are not priced.
function expandPricedEntries(entries) {
  return (entries ?? []).flatMap((entry) => {
    if (typeof entry === "string") return [[entry, null, entry]];
    const canonical = String(entry.model ?? "").trim();
    const aliases = [canonical, ...(Array.isArray(entry.aliases) ? entry.aliases : [])]
      .map((value) => String(value ?? "").trim())
      .filter(Boolean);
    const price = entry.priceCny === null || entry.priceCny === undefined
      ? null
      : Number(entry.priceCny);
    return aliases.map((alias) => [alias, Number.isFinite(price) ? price : null, canonical]);
  });
}

const CPU_PRICES = expandPricedEntries(CATALOG.cpu);
const GPU_PRICES = expandPricedEntries(CATALOG.gpu);
const MEMORY_PRICES = (CATALOG.memory ?? []).map((entry) => [
  entry.generation,
  Number(entry.capacityG),
  entry.frequencyMhz === null || entry.frequencyMhz === undefined ? null : Number(entry.frequencyMhz),
  Number(entry.priceCny)
]);

const MOTHERBOARD_CHIPSETS = [
  "x670", "x570", "b650", "b550", "b450", "b760", "b660", "b560", "b550m",
  "b460", "b450m", "h610", "h510", "h410", "z790", "z690", "z590", "z490",
  "z390", "h770", "h670", "a520", "a320"
];

const UNUSABLE_TERMS = [
  "坏",
  "故障",
  "维修",
  "修过",
  "矿卡",
  "花屏",
  "黑屏",
  "不亮",
  "缺件",
  "尸体",
  "拆机",
  "仅测试",
  "不能正常使用",
  "无法正常使用",
  "不开机"
];

const DESKTOP_TITLE_TERMS = [
  /(?:台式主机|台式整机|台式机|组装电脑|组装主机|电脑整机)/
];
const DESKTOP_DETAIL_TERMS = [
  /(?:整机|整套|整台).{0,16}(?:出售|出|转让|自用)/,
  /(?:出售|转让|自用).{0,16}(?:台式主机|电脑主机|电脑整机|台式整机|组装电脑|游戏主机)/,
  /(?:台式主机|电脑整机|台式整机|台式机|组装电脑|组装主机)/
];
const NON_DESKTOP_TERMS = /笔记本|手提电脑|一体机|掌机|playstation|xbox|任天堂|switch|ps[345]/i;
const PART_ONLY_TERMS =
  /(?:单卖|单出|只出|只卖|仅卖|仅出|仅售).{0,10}(?:显卡|cpu|处理器|主板|内存|硬盘|ssd|配件)|(?:显卡|cpu|处理器|主板|内存|硬盘|ssd)(?:单卖|单出|单售)|电脑配件|配件套装|散件|准系统|板u套装|主板套装|不含(?:显卡|cpu|内存|硬盘)|不带(?:显卡|cpu|内存|硬盘)/i;
const EXPLICIT_MERCHANT_TERMS =
  /旗舰店|专营店|专卖店|企业店|企业认证|企业商家|公司经营|营业执照|个体工商户|实体店|线下门店|电脑店|数码店|装机店|店铺主页|本店|门店经营/i;
const MERCHANT_SIGNAL_GROUPS = [
  ["批发经营", /批发|同行|分销|代理供货/],
  ["回收经营", /回收|以旧换新|折抵换新|高价收/],
  ["批量库存", /库存|大量现货|现货充足|批量出售|大量供应|批量供货/],
  ["实体经营", /电脑城|商场柜台|门店|实体店|线下经营/]
];

function normalizeText(value) {
  return String(value ?? "")
    .toLocaleLowerCase("zh-CN")
    .replace(/[（(]/g, " ")
    .replace(/[）)]/g, " ")
    .replace(/[：:]/g, ":")
    .replace(/\s+/g, " ")
    .trim();
}

function compact(value) {
  return normalizeText(value).replace(/[\s_-]+/g, "");
}

function normalizeCatalogText(value, type) {
  let source = normalizeText(value);
  if (type === "cpu") {
    source = source
      .replace(/酷睿/g, "i")
      .replace(/锐龙/g, "r")
      .replace(/ryzen\s*([3579])/g, "r$1")
      .replace(/英特尔/g, "intel");
  }
  if (type === "gpu") {
    source = source
      .replace(/ti\s*super/g, "tis")
      .replace(/super/g, "s");
  }
  return compact(source);
}

function numberFrom(value) {
  const match = String(value ?? "").match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function toComponent(type, model, priceCny, extra = {}) {
  return { type, model, priceCny, ...extra };
}

function findLongest(text, entries, type) {
  const source = normalizeCatalogText(text, type);
  const ordered = [...entries].sort((a, b) => compact(b[0]).length - compact(a[0]).length);
  for (const [model, price, canonical = model] of ordered) {
    if (source.includes(normalizeCatalogText(model, type))) {
      return toComponent(type, canonical.toUpperCase(), price);
    }
  }
  return null;
}

function findCatalogModels(text, entries, type) {
  const source = normalizeCatalogText(text, type);
  const matches = entries
    .map(([alias, , canonical = alias]) => ({
      alias: normalizeCatalogText(alias, type),
      canonical
    }))
    .filter(({ alias }) => {
      if (!alias) return false;
      if (source.includes(alias)) return true;
      if (type !== "gpu") return false;
      const withoutVendor = alias.replace(/^(?:rtx|gtx|rx|arc)/, "");
      return source.includes(alias) || (withoutVendor && source.includes(withoutVendor));
    });
  const longestMatches = matches.filter(({ alias }) => !matches.some((other) =>
    other.alias.length > alias.length && other.alias.includes(alias) && source.includes(other.alias)
  ));
  return [...new Set(longestMatches.map(({ canonical }) => canonical))];
}

function parseCpu(text) {
  const source = normalizeText(text)
    .replace(/酷睿/g, "i")
    .replace(/锐龙/g, "r")
    .replace(/ryzen\s*([3579])/g, "r$1")
    .replace(/英特尔/g, "intel");
  const component = findLongest(source, CPU_PRICES, "cpu");
  if (component) component.model = component.model.replace(/-/g, " ");
  if (component) return component;

  const unknown = source.match(/\b((?:i|r)[3579]\s*[- ]?\d{3,5}[a-z0-9]*|xeon\s+[a-z0-9-]+|threadripper\s+[a-z0-9-]+)\b/i);
  return unknown
    ? toComponent("cpu", unknown[1].replace(/-/g, " ").toUpperCase(), null, { unsupported: true })
    : null;
}

function parseGpu(text) {
  const source = normalizeText(text)
    .replace(/显卡/g, " ")
    .replace(/ti\s*super/g, "tis")
    .replace(/super/g, "s");
  const full = findLongest(source, GPU_PRICES, "gpu");
  if (full) return full;

  // Some sellers omit the vendor prefix: "3060 12G". Match the full
  // memory variant before falling back to an unqualified model.
  const compactSource = compact(source);
  const bareVariant = [...GPU_PRICES]
    .filter(([model]) => /\d+g$/.test(compact(model)))
    .sort((a, b) => compact(b[0]).length - compact(a[0]).length)
    .find(([model]) => {
      const bare = compact(model).replace(/^(?:rtx|gtx|rx|arc)/, "");
      return bare && compactSource.includes(bare);
    });
  if (bareVariant) {
    const [model, price, canonical = model] = bareVariant;
    return toComponent("gpu", canonical.toUpperCase(), price);
  }

  const genericPrices = new Map();
  for (const [model, price, canonical = model] of GPU_PRICES) {
    const normalizedModel = compact(model);
    const numericAlias = normalizedModel.replace(/^(?:rtx|gtx|rx|arc)/, "");
    const baseAlias = numericAlias.replace(/\d+g$/, "");
    if (numericAlias && !/\d+g$/.test(numericAlias)) {
      genericPrices.set(numericAlias, [canonical, price]);
    } else if (baseAlias && !genericPrices.has(baseAlias)) {
      // A bare model without VRAM is ambiguous; use the first catalog variant
      // as a conservative estimate and let the full variant win when present.
      genericPrices.set(baseAlias, [canonical, price]);
    }
  }
  for (const [alias, [model, price]] of [...genericPrices.entries()].sort((a, b) => b[0].length - a[0].length)) {
    if (compactSource.includes(alias)) return toComponent("gpu", model.toUpperCase(), price);
  }
  const unknown = source.match(/\b((?:rtx|gtx|rx|arc)\s*[a-z0-9]+(?:\s*(?:ti|super|xt|xtx|s))?(?:\s*\d+\s*g)?)\b/i);
  return unknown
    ? toComponent("gpu", unknown[1].replace(/\s+/g, " ").toUpperCase(), null, { unsupported: true })
    : null;
}

function parseMotherboard(text) {
  const source = compact(text);
  const chipset = [...MOTHERBOARD_CHIPSETS]
    .sort((a, b) => b.length - a.length)
    .find((item) => source.includes(compact(item)));
  return chipset
    ? toComponent("motherboard", chipset.toUpperCase(), VALUATION_DEFAULTS.motherboardDefaultCny)
    : toComponent("motherboard", "未识别主板", VALUATION_DEFAULTS.motherboardDefaultCny, { default: true });
}

function parseMemory(text) {
  const source = normalizeText(text);
  const generationMatch = source.match(/ddr\s*([345])/i);
  const generation = generationMatch?.[1];
  if (!generation) return null;
  const generationIndex = source.search(/ddr\s*[345]/i);
  const nearby = source.slice(Math.max(0, generationIndex - 24), generationIndex + 100);
  const afterGeneration = source.slice(generationIndex + generationMatch[0].length);
  const afterCapacity = afterGeneration.match(/(?:^|[^\d])(4|8|16|32|64)\s*(?:g|gb)(?:\b|内存|内)/i);
  const beforeCapacities = [...nearby.matchAll(/(?:^|[^\d])(4|8|16|32|64)\s*(?:g|gb)(?:\b|内存|内)/gi)];
  const capacity = afterCapacity
    ? Number(afterCapacity[1])
    : beforeCapacities.length
      ? Number(beforeCapacities.at(-1)[1])
      : null;
  if (![4, 8, 16, 32, 64].includes(capacity)) return null;
  const frequency = numberFrom(afterGeneration.match(/(?:^|\D)(1600|1866|2133|2400|2666|3200|3600|4800|5200|5600|6000|6400)\s*(?:mhz)?(?:\D|$)/i)?.[1]);
  const generationName = `ddr${generation}`;
  const candidates = MEMORY_PRICES.filter(([gen, size]) => gen === generationName && size === capacity);
  if (!candidates.length) return null;
  const selected = [...candidates].sort((a, b) => {
    const distanceA = frequency === null || a[2] === null ? 0 : Math.abs(a[2] - frequency);
    const distanceB = frequency === null || b[2] === null ? 0 : Math.abs(b[2] - frequency);
    return distanceA - distanceB || a[3] - b[3];
  })[0];
  const label = `${generationName.toUpperCase()} ${capacity}G${selected[2] ? ` ${selected[2]}` : ""}`;
  return toComponent("memory", label, selected[3], {
    generation: generationName,
    capacityG: capacity,
    frequencyMhz: selected[2],
    frequencyProvided: frequency !== null
  });
}

function parseStorage(text) {
  const source = normalizeText(text);
  if (!/(固态|ssd|nvme|m\.2)/i.test(source)) return null;
  const markerIndex = source.search(/固态|ssd|nvme|m\.2/i);
  const nearby = source.slice(Math.max(0, markerIndex - 50), markerIndex + 90);
  const match = nearby.match(/(?:^|[^\d])(2048|1024|512|256|2|1)\s*(tb|t|g|gb)(?:\b|固态|硬盘)/i);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const key = unit.startsWith("t") || value === 1024 || value === 2048
    ? `${value === 1024 ? 1 : value === 2048 ? 2 : value}tb`
    : `${value}g`;
  const price = VALUATION_DEFAULTS.storagePricesCny[key];
  if (!price) return toComponent("storage", `${value}${unit.toUpperCase()} 固态`, null, { unsupported: true });
  return toComponent("storage", `${key.toUpperCase()} 固态`, price, { capacity: key });
}

function classifyDesktopListing(title, description) {
  const normalizedTitle = normalizeText(title);
  const normalizedDescription = normalizeText(description);
  const combined = `${normalizedTitle}\n${normalizedDescription}`;

  if (NON_DESKTOP_TERMS.test(combined)) {
    return { eligible: false, status: "non_desktop", reason: "笔记本、一体机或游戏机不是目标整机" };
  }
  if (PART_ONLY_TERMS.test(combined)) {
    return { eligible: false, status: "parts_listing", reason: "疑似配件、散件或不完整主机商品" };
  }

  const clearTitle = DESKTOP_TITLE_TERMS.some((pattern) => pattern.test(normalizedTitle));
  const clearDescription = DESKTOP_DETAIL_TERMS.some((pattern) => pattern.test(normalizedDescription));
  if (!clearTitle && !clearDescription) {
    return { eligible: false, status: "not_desktop", reason: "标题和详情未明确说明出售完整台式主机" };
  }
  return { eligible: true, status: "estimated", reason: null };
}

function classifySellerRisk({ sellerName = "", sellerType = "", title = "", description = "" }) {
  const source = `${sellerName}\n${sellerType}\n${title}\n${description}`;
  const explicit = source.match(EXPLICIT_MERCHANT_TERMS)?.[0];
  const signals = MERCHANT_SIGNAL_GROUPS
    .filter(([, pattern]) => pattern.test(source))
    .map(([label]) => label);
  const reasons = [
    ...(explicit ? [`明确商家标识：${explicit}`] : []),
    ...signals
  ];
  return {
    level: explicit || signals.length >= 2 ? "high" : "unknown",
    reasons
  };
}

function configurationConflicts(title, description, combinedText) {
  const conflicts = [];
  const allCpuModels = findCatalogModels(combinedText, CPU_PRICES, "cpu");
  const allGpuModels = findCatalogModels(combinedText, GPU_PRICES, "gpu");
  if (allCpuModels.length > 1) conflicts.push("文本中出现多个 CPU 型号，无法确认实际配置");
  if (allGpuModels.length > 1) conflicts.push("文本中出现多个显卡型号，无法确认实际配置");

  const titleCpu = parseCpu(title);
  const detailCpu = parseCpu(description);
  if (titleCpu && detailCpu && compact(titleCpu.model) !== compact(detailCpu.model)) {
    conflicts.push("标题与详情的 CPU 型号不一致");
  }
  const titleGpu = parseGpu(title);
  const detailGpu = parseGpu(description);
  if (titleGpu && detailGpu && compact(titleGpu.model) !== compact(detailGpu.model)) {
    conflicts.push("标题与详情的显卡型号不一致");
  }
  const titleMemory = parseMemory(title);
  const detailMemory = parseMemory(description);
  if (titleMemory && detailMemory) {
    const capacityDiffers = titleMemory.generation !== detailMemory.generation
      || titleMemory.capacityG !== detailMemory.capacityG;
    const knownFrequenciesDiffer = titleMemory.frequencyProvided
      && detailMemory.frequencyProvided
      && titleMemory.frequencyMhz !== detailMemory.frequencyMhz;
    if (capacityDiffers || knownFrequenciesDiffer) {
      conflicts.push("标题与详情的内存规格不一致");
    }
  }
  return [...new Set(conflicts)];
}

export function parseComponents(text) {
  const source = String(text ?? "");
  const components = {
    cpu: parseCpu(source),
    gpu: parseGpu(source),
    motherboard: parseMotherboard(source),
    memory: parseMemory(source),
    storage: parseStorage(source)
  };
  const missingParts = [];
  if (!Number.isFinite(components.cpu?.priceCny)) missingParts.push("cpu");
  if (!Number.isFinite(components.gpu?.priceCny)) missingParts.push("gpu");
  if (components.motherboard?.default) missingParts.push("motherboard");
  if (!components.memory) missingParts.push("memory");
  if (!components.storage) missingParts.push("storage");
  const unsupportedParts = Object.values(components)
    .filter((component) => component?.unsupported)
    .map((component) => component.type);
  if (unsupportedParts.length) missingParts.push(...unsupportedParts);
  const normalized = normalizeText(text);
  const conditionIssues = UNUSABLE_TERMS.filter((term) => normalized.includes(normalizeText(term)));
  return { components, missingParts: [...new Set(missingParts)], conditionIssues };
}

export function estimateDesktopListing({
  title = "",
  description = "",
  sellerName = "",
  sellerType = "",
  detailError = "",
  price,
  tolerancePercent = VALUATION_DEFAULTS.tolerancePercent,
  hostCapCny = VALUATION_DEFAULTS.hostCapCny
}) {
  const text = `${title}\n${description}`;
  const { components, missingParts, conditionIssues } = parseComponents(text);
  const desktop = classifyDesktopListing(title, description);
  const sellerRisk = classifySellerRisk({ sellerName, sellerType, title, description });
  const conflicts = configurationConflicts(title, description, text);
  const priced = Object.values(components).filter((component) => Number.isFinite(component?.priceCny));
  const valuationCny = priced.reduce((sum, component) => sum + component.priceCny, 0);
  const requiredParts = [
    ["cpu", "CPU 型号未识别或价格表未覆盖"],
    ["gpu", "显卡型号未识别或价格表未覆盖"],
    ["memory", "内存容量或规格未识别"],
    ["storage", "固态硬盘容量未识别或不在价格表范围内"]
  ];
  const missingRequired = requiredParts
    .filter(([key]) => !Number.isFinite(components[key]?.priceCny))
    .map(([, reason]) => reason);
  const capped = valuationCny > hostCapCny;
  const unusable = conditionIssues.length > 0;
  const salePrice = Number(price);
  const { lowerPrice, upperPrice } = valuationBounds(valuationCny, tolerancePercent);
  const extremelyLow = valuationCny > 0 && salePrice < lowerPrice;
  const eligibilityReasons = [
    ...(!desktop.eligible ? [desktop.reason] : []),
    ...(detailError ? [`详情读取失败：${detailError}`] : []),
    ...(unusable ? [`疑似故障或非正常可用：${conditionIssues.join("、")}`] : []),
    ...(sellerRisk.level === "high" ? [`商家风险较高：${sellerRisk.reasons.join("、")}`] : []),
    ...conflicts,
    ...missingRequired,
    ...(capped ? [`核心部件回收估值超过 ${roundPrice(hostCapCny)} 元`] : []),
    ...(!Number.isFinite(salePrice) ? ["商品价格无法识别"] : []),
    ...(Number.isFinite(salePrice) && salePrice > upperPrice
      ? [`商品价高于估值上限 ${roundPrice(upperPrice)} 元`]
      : [])
  ];
  const matched = eligibilityReasons.length === 0;
  const componentStatus = missingRequired.length
    ? (missingRequired.some((reason) => reason.startsWith("CPU") || reason.startsWith("显卡"))
      ? "missing_required"
      : "incomplete_configuration")
    : capped
      ? "over_cap"
      : "estimated";
  const status = !desktop.eligible
    ? desktop.status
    : detailError
      ? "detail_error"
      : unusable
        ? "unusable"
        : sellerRisk.level === "high"
          ? "merchant_risk"
          : conflicts.length
            ? "configuration_conflict"
            : componentStatus === "missing_required" || componentStatus === "incomplete_configuration" || componentStatus === "over_cap"
              ? componentStatus
              : !Number.isFinite(salePrice)
                ? "unpriced"
                : salePrice > upperPrice
                  ? "price_too_high"
                  : "estimated";
  const confidence = unusable || !desktop.eligible || missingRequired.length || conflicts.length
    ? "low"
    : missingParts.length ? "medium" : "high";
  return {
    matched,
    eligible: desktop.eligible,
    desktopEligible: desktop.eligible,
    components,
    valuationCny,
    valuationStatus: status,
    valuationConfidence: confidence,
    missingParts,
    conditionIssues,
    eligibilityReasons,
    sellerRiskLevel: sellerRisk.level,
    sellerRiskReasons: sellerRisk.reasons,
    configurationConflicts: conflicts,
    unusable,
    extremelyLow,
    lowerPrice,
    upperPrice,
    price: salePrice,
    priceTableVersion: PRICE_TABLE_VERSION
  };
}

function roundPrice(value) {
  return Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

export function valuationBounds(valuationCny, tolerancePercent = VALUATION_DEFAULTS.tolerancePercent) {
  const valuation = Number(valuationCny);
  const tolerance = Number(tolerancePercent);
  const safeValuation = Number.isFinite(valuation) && valuation >= 0 ? valuation : 0;
  const safeTolerance = Number.isFinite(tolerance)
    ? Math.min(100, Math.max(0, tolerance))
    : VALUATION_DEFAULTS.tolerancePercent;
  return {
    lowerPrice: safeValuation * (1 - safeTolerance / 100),
    upperPrice: safeValuation * (1 + safeTolerance / 100)
  };
}

export function valuationSettings() {
  return {
    priceTableVersion: PRICE_TABLE_VERSION,
    sourceDate: CATALOG.sourceDate ?? null,
    hostCapCny: VALUATION_DEFAULTS.hostCapCny,
    tolerancePercent: VALUATION_DEFAULTS.tolerancePercent,
    defaultMotherboardCny: VALUATION_DEFAULTS.motherboardDefaultCny,
    storagePricesCny: VALUATION_DEFAULTS.storagePricesCny,
    supportedParts: ["cpu", "gpu", "motherboard", "memory", "storage"],
    unusableTerms: UNUSABLE_TERMS
  };
}

export function valuationCatalog() {
  return {
    version: PRICE_TABLE_VERSION,
    sourceDate: CATALOG.sourceDate ?? null,
    cpu: Object.fromEntries(CPU_PRICES),
    gpu: Object.fromEntries(GPU_PRICES),
    memory: MEMORY_PRICES.map(([generation, capacityG, frequencyMhz, priceCny]) => ({
      generation, capacityG, frequencyMhz, priceCny
    })),
    motherboardDefaultCny: VALUATION_DEFAULTS.motherboardDefaultCny,
    storage: VALUATION_DEFAULTS.storagePricesCny
  };
}

export { PRICE_TABLE_VERSION };
