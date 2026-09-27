import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const DEFAULT_APPRAISAL = {
  // 推送窗口：卖家价与"表价合计"相差在该值以内（±）即命中。
  // 例：合计 3750、窗口 550 → 卖家价在 [3200, 4300] 内都推送。
  toleranceMachine: 550,
  toleranceSingle: 550,
  // 整机收购范围：估价合计低于下限或高于上限的整机不收（不推送）。
  machineMinSum: 1300,
  machineMaxSum: 7000,
  // 非一线品牌默认折减金额（表1：其他牌子减10-100不等）。
  otherBrandDiscount: 50,
  // P2 接入扫描后：影子模式只记录不推送。
  shadowMode: true
};

function clampInteger(value, minimum, maximum, fallback) {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, number));
}

export function normalizeAppraisal(input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const machineMinSum = clampInteger(source.machineMinSum, 0, 1_000_000, DEFAULT_APPRAISAL.machineMinSum);
  const machineMaxSum = Math.max(
    machineMinSum,
    clampInteger(source.machineMaxSum, 0, 1_000_000, DEFAULT_APPRAISAL.machineMaxSum)
  );
  return {
    toleranceMachine: clampInteger(source.toleranceMachine, 0, 100_000, DEFAULT_APPRAISAL.toleranceMachine),
    toleranceSingle: clampInteger(source.toleranceSingle, 0, 100_000, DEFAULT_APPRAISAL.toleranceSingle),
    machineMinSum,
    machineMaxSum,
    otherBrandDiscount: clampInteger(source.otherBrandDiscount, 0, 500, DEFAULT_APPRAISAL.otherBrandDiscount),
    shadowMode: source.shadowMode !== false
  };
}

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function maskSpans(text, spans) {
  if (!spans.length) {
    return text;
  }
  const characters = [...text];
  for (const span of spans) {
    for (let index = span.start; index < span.end && index < characters.length; index += 1) {
      characters[index] = " ";
    }
  }
  return characters.join("");
}

// ---------------------------------------------------------------------------
// GPU: "RTX3060 12G" / "gtx1660s" / "3060ti 8G" / "4070ti super"
// ---------------------------------------------------------------------------

const FIRST_TIER_FALLBACK = ["华硕", "技嘉", "微星", "七彩虹", "影驰"];
const OTHER_BRANDS = /索泰|耕升|铭瑄|盈通|昂达|翔升|万丽|映众|蓝宝石|迪兰|瀚铠|镭风|精影|小影霸|梅捷|铭鑫|升技/;

function normalizeSuffix(value) {
  const raw = String(value ?? "").toUpperCase().replace(/\s+/g, "");
  if (raw === "TISUPER") {
    return "TIS";
  }
  if (raw === "SUPER") {
    return "S";
  }
  return raw;
}

function buildGpuIndex(gpuTable) {
  const byModel = new Map();
  const items = Array.isArray(gpuTable?.items) ? gpuTable.items : [];
  for (const item of items) {
    const model = String(item?.model ?? "").trim();
    const price = Number(item?.price);
    if (!model || !Number.isFinite(price) || price <= 0) {
      continue;
    }
    const entry = {
      model,
      suffix: normalizeSuffix(item?.suffix),
      vram: String(item?.vram ?? "").toUpperCase(),
      price,
      note: String(item?.note ?? ""),
      low: item?.low === true
    };
    if (!byModel.has(model)) {
      byModel.set(model, []);
    }
    byModel.get(model).push(entry);
  }
  return byModel;
}

function pickGpuEntry(entries, suffix, vram) {
  let pool = entries.filter((entry) => entry.suffix === suffix);
  if (!pool.length && suffix === "") {
    pool = entries.filter((entry) => entry.suffix === "");
  }
  if (!pool.length) {
    pool = entries;
  }
  if (pool.length === 1) {
    return { entry: pool[0], resolved: true, note: "" };
  }
  if (vram) {
    const exact = pool.find((entry) => entry.vram === vram);
    if (exact) {
      return { entry: exact, resolved: true, note: "" };
    }
    const plain = pool.find((entry) => !entry.vram);
    if (plain) {
      return { entry: plain, resolved: true, note: `未采用 ${vram} 版` };
    }
  } else {
    const plain = pool.find((entry) => !entry.vram);
    if (plain) {
      const variants = pool.some((entry) => entry.vram);
      return { entry: plain, resolved: !variants, note: variants ? "显存未标明，按标准版估" : "" };
    }
  }
  const cheapest = [...pool].sort((left, right) => left.price - right.price)[0];
  return { entry: cheapest, resolved: false, note: "显存未标明，按低版估（保守）" };
}

function findGpu(text, byModel) {
  const normalized = text.replace(/ti\s?super/gi, "TIS");
  const pattern = /(?:rtx|gtx)?\s?(\d{3,4})\s?(TIS|TI|SUPER|S)?\s?(?:(\d{1,2})\s?G)?/gi;
  for (const match of normalized.matchAll(pattern)) {
    const model = match[1];
    const entries = byModel.get(model);
    if (!entries) {
      continue;
    }
    const suffix = normalizeSuffix(match[2]);
    const vram = match[3] ? `${match[3]}G` : "";
    const picked = pickGpuEntry(entries, suffix, vram);
    return {
      entry: picked.entry,
      resolved: picked.resolved,
      note: picked.note,
      span: { start: match.index, end: match.index + match[0].length }
    };
  }
  return null;
}

function detectBrand(text, brandRule) {
  const firstTier = Array.isArray(brandRule?.firstTier) && brandRule.firstTier.length
    ? brandRule.firstTier.map(String)
    : FIRST_TIER_FALLBACK;
  for (const brand of firstTier) {
    if (brand && text.includes(brand)) {
      return { brand, tier: "first" };
    }
  }
  const other = text.match(OTHER_BRANDS);
  if (other) {
    return { brand: other[0], tier: "other" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// CPU: Intel "i5 12400F" / Ryzen "R5 5600X" / "速龙3000G"
// ---------------------------------------------------------------------------

function lookupNamed(items, candidates) {
  if (!Array.isArray(items) || !items.length || !candidates.length) {
    return null;
  }
  const index = new Map();
  for (const item of items) {
    const model = String(item?.model ?? "").toUpperCase().replace(/\s+/g, " ").trim();
    if (model && !index.has(model)) {
      index.set(model, item);
    }
  }
  for (const candidate of candidates) {
    const key = String(candidate).toUpperCase().replace(/\s+/g, " ").trim();
    if (index.has(key)) {
      return index.get(key);
    }
  }
  return null;
}

function introCpuCandidates(tier, digits, suffix) {
  const base = `i${tier} ${digits}`;
  const candidates = [];
  if (suffix) {
    candidates.push(`${base}${suffix}`, base);
  } else {
    candidates.push(base);
  }
  return candidates;
}

// 表3（Intel）可能只登记了 "i5 12400F" 这类完整型号，
// 但闲鱼标题经常只写 "12400F"、"10400 主机"，所以按数字匹配。
const RYZEN_BARE_EXCLUDE = new Set(["7500", "8400", "7400"]);

function lookupByDigits(items, digits, suffix) {
  if (!Array.isArray(items) || !items.length) {
    return null;
  }
  let fallback = null;
  let noSuffix = null;
  for (const item of items) {
    const model = String(item?.model ?? "");
    const found = model.match(/(\d{4,5})([A-Za-z]*)/);
    if (!found || found[1] !== digits) {
      continue;
    }
    const itemSuffix = (found[2] ?? "").toUpperCase();
    if (itemSuffix === suffix) {
      return item;
    }
    fallback ??= item;
    if (!itemSuffix && !noSuffix) {
      noSuffix = item;
    }
  }
  return noSuffix ?? fallback;
}

function findIntelCpu(text, intelTable) {
  let tier = null;
  let digits = "";
  let suffix = "";
  let matched = text.match(/i([3579])[\s-]?(\d{4,5})([a-z]{0,3})?(?![a-z0-9])/i);
  if (matched) {
    tier = matched[1];
    digits = matched[2];
    suffix = (matched[3] ?? "").toUpperCase();
  } else {
    matched = text.match(/(?:^|[^\dA-Za-z])((?:1[0-4]\d{3})[fkt]{0,2}|(?:[4-9]\d{3})[fkt]{1,2})(?![0-9A-Za-z])/i);
    if (!matched) {
      return null;
    }
    const parsed = matched[1].match(/(\d{4,5})([A-Za-z]*)/);
    digits = parsed[1];
    suffix = (parsed[2] ?? "").toUpperCase();
    if (!digits.startsWith("1") && RYZEN_BARE_EXCLUDE.has(digits)) {
      // "7500F"/"8400F" 是锐龙，交给 Ryzen 识别。
      return null;
    }
  }
  const item = lookupByDigits(intelTable?.items, digits, suffix)
    ?? (tier ? lookupNamed(intelTable?.items, introCpuCandidates(tier, digits, suffix)) : null);
  const label = tier ? `i${tier} ${digits}${suffix}` : `Intel ${digits}${suffix}`;
  return {
    label,
    price: Number.isFinite(Number(item?.price)) && Number(item?.price) > 0 ? Number(item.price) : null,
    low: item?.low === true,
    span: { start: matched.index ?? 0, end: (matched.index ?? 0) + matched[0].length }
  };
}

function findRyzenCpu(text, cpuTable) {
  const match = text.match(/(?:r|锐龙)\s?([3579])\s?-?\s?(\d{3,4})\s?([a-z0-9]{0,4})?(?![a-z0-9])/i);
  if (!match) {
    return /锐龙/.test(text) ? { label: "锐龙（型号未识别）", price: null, low: false, span: null } : null;
  }
  const series = match[1];
  const model = match[2];
  const suffix = (match[3] ?? "").toUpperCase();
  const candidates = [`R${series} ${model}${suffix}`];
  if (suffix) {
    candidates.push(`R${series} ${model}`);
  }
  const item = lookupNamed(cpuTable?.items, candidates);
  return {
    label: `R${series} ${model}${suffix}`,
    price: Number.isFinite(Number(item?.price)) && Number(item?.price) > 0 ? Number(item.price) : null,
    low: item?.low === true,
    span: { start: match.index, end: match.index + match[0].length }
  };
}

function findAthlonOld(text, cpuTable) {
  const match = text.match(/(?:速龙\s?)?(A8|A10|X4|FX)\s?-?\s?(\d{3,4}[A-Z]{0,2})/i);
  if (!match) {
    return null;
  }
  const model = `${match[1].toUpperCase()} ${match[2].toUpperCase()}`;
  const item = lookupNamed(cpuTable?.items, [model]);
  return {
    label: model,
    price: Number.isFinite(Number(item?.price)) && Number(item?.price) > 0 ? Number(item.price) : null,
    low: item?.low === true,
    span: { start: match.index, end: match.index + match[0].length }
  };
}

// ---------------------------------------------------------------------------
// Storage & RAM
// ---------------------------------------------------------------------------

function findStorage(text) {
  const numberUnit = /(\d{1,4})\s?(GB|TB|G|T)\s?(固态|ssd|nvme|m\.?2|硬盘|机械|hdd)/i;
  const unitNumber = /(固态|ssd|nvme|m\.?2|硬盘|机械|hdd)\s?(\d{1,4})\s?(GB|TB|G|T)/i;
  const numberOnly = /(\d{2,4})\s?(固态|ssd|nvme|m\.?2|硬盘|机械|hdd)/i;
  const candidates = [];
  const first = numberUnit.exec(text);
  if (first) {
    candidates.push({ match: first, sizeText: first[1], unit: first[2], qualifier: first[3] });
  }
  const second = unitNumber.exec(text);
  if (second) {
    candidates.push({ match: second, sizeText: second[2], unit: second[3], qualifier: second[1] });
  }
  const third = numberOnly.exec(text);
  if (third) {
    candidates.push({ match: third, sizeText: third[1], unit: "", qualifier: third[2] });
  }
  candidates.sort((left, right) => left.match.index - right.match.index);
  for (const candidate of candidates) {
    const size = /^t/i.test(candidate.unit) ? Number(candidate.sizeText) * 1000 : Number(candidate.sizeText);
    if (!Number.isFinite(size) || size < 60 || size > 8000) {
      continue;
    }
    const kind = /机械|hdd/i.test(candidate.qualifier)
      ? "mechanical"
      : /nvme|m\.?2|pcie/i.test(candidate.qualifier)
        ? "nvme"
        : "sata";
    return {
      label: `${candidate.sizeText}${candidate.unit.toUpperCase()}${kind === "nvme" ? " NVMe" : kind === "mechanical" ? " 机械" : " 固态"}`,
      size,
      kind,
      span: { start: candidate.match.index, end: candidate.match.index + candidate.match[0].length }
    };
  }
  return null;
}

const RAM_SIZES = [4, 8, 16, 32, 64];

function findRam(text) {
  const pair = text.match(/(\d{1,3})\s?G?\s?[+＋]\s?(\d{1,3})\s?G/i);
  if (pair) {
    const left = Number(pair[1]);
    const right = Number(pair[2]);
    if (left === right && RAM_SIZES.includes(left)) {
      return { per: left, count: 2, explicit: true };
    }
  }
  const multiple = text.match(/(\d{1,3})\s?G\s?(?:×|\*|x|X)\s?2|2\s?(?:×|\*|x|X)\s?(\d{1,3})\s?G|(\d{1,3})\s?G\s?(?:两根|两条|双条)|(?:两根|两条|双条)\s?(\d{1,3})\s?G/i);
  if (multiple) {
    const size = Number(multiple[1] ?? multiple[2] ?? multiple[3] ?? multiple[4]);
    if (RAM_SIZES.includes(size)) {
      return { per: size, count: 2, explicit: true };
    }
  }
  const explicitPatterns = [
    /(\d{1,3})\s?GB?\s*(?:内存|双通道|套条|马甲|条|根)/i,
    /(?:内存|双通道|套条|马甲)\s*[：:\-]?\s*(\d{1,3})\s?GB?/i,
    /ddr\s?[345][^-]{0,8}?(\d{1,3})\s?GB?/i,
    /(\d{1,3})\s?GB?\s*(?:3200|3000|2666|2400|2133|3600|1866|1600)/i
  ];
  for (const pattern of explicitPatterns) {
    const match = pattern.exec(text);
    if (!match) {
      continue;
    }
    const size = Number(match[1]);
    if (!RAM_SIZES.includes(size)) {
      continue;
    }
    return { per: size, count: 1, explicit: true, span: { start: match.index, end: match.index + match[0].length } };
  }
  const bare = /(\d{1,3})\s?GB?(?![a-z])/i.exec(text);
  if (bare) {
    const size = Number(bare[1]);
    if (RAM_SIZES.includes(size)) {
      return {
        per: size,
        count: 1,
        explicit: false,
        contextless: true,
        span: { start: bare.index, end: bare.index + bare[0].length }
      };
    }
  }
  return null;
}

function lookupMemory(memoryTable, section, ddr, size) {
  const list = Array.isArray(memoryTable?.[section]) ? memoryTable[section] : [];
  const key = `${ddr} ${size}G`.toUpperCase();
  const exact = list.find((item) => String(item?.model ?? "").toUpperCase() === key);
  const prefix = exact ?? list.find((item) => String(item?.model ?? "").toUpperCase().startsWith(key));
  return prefix ?? null;
}

// ---------------------------------------------------------------------------
// Main appraisal
// ---------------------------------------------------------------------------

const MACHINE_WORDS = /主机|整机|台式|组装机|全套|电脑/;
const NUCLEAR_GRAPHICS = /核显|集显|集成显卡|无显卡|无独立显卡|亮机卡|亮机/;
const RISK_WORDS = /坏|故障|进水|点不亮|开不了机|花屏|黑屏|矿卡|矿机|拆修|维修过|魔改|尸体|报废/g;
const NOTEBOOK_WORDS = /笔记本|游戏本|轻薄本|本本/;

export function appraiseText(tables, text, sellerPrice, settings) {
  const source = cleanText(text);
  const config = normalizeAppraisal(settings ?? {});
  const flags = [];
  const parts = [];
  const excluded = [];
  const spans = [];

  const gpuTable = tables?.gpu ?? {};
  const cpuTable = tables?.cpu ?? {};
  const intelTable = tables?.intelCpu ?? {};
  const memoryTable = tables?.memory ?? {};
  const storageTable = tables?.storage ?? {};

  // --- GPU ---------------------------------------------------------------
  const byModel = buildGpuIndex(gpuTable);
  const gpu = findGpu(source, byModel);
  if (gpu) {
    spans.push(gpu.span);
    const brand = detectBrand(source, gpuTable.brandRule);
    let price = gpu.entry.price;
    const notes = [`表1${gpu.entry.note ? ` · ${gpu.entry.note}` : ""}${gpu.entry.low ? " · 低置信价" : ""}`];
    if (brand?.tier === "first") {
      notes.push(`${brand.brand}（一线）`);
    } else {
      price = Math.max(0, price - config.otherBrandDiscount);
      notes.push(brand ? `${brand.brand}（非一线 -${config.otherBrandDiscount}）` : `品牌不明（按非一线 -${config.otherBrandDiscount}）`);
    }
    if (gpu.note) {
      notes.push(gpu.note);
    }
    const gpuPrefix = Number(gpu.entry.model) >= 2000 ? "RTX" : "GTX";
    parts.push({
      type: "gpu",
      label: `${gpuPrefix}${gpu.entry.model}${gpu.entry.suffix ?? ""}${gpu.entry.vram ? ` ${gpu.entry.vram}` : ""}`,
      price,
      status: gpu.entry.low ? "low" : "ok",
      notes
    });
  } else if (/rx\s?\d{3,4}|radeon|vega|6600\s?xt|5700\s?xt/i.test(source)) {
    const amd = source.match(/(?:rx|radeon|vega)\s?-?\s?\d{3,4}\s?(?:xt)?\s?(?:\d{1,2}\s?G)?/i);
    if (amd) {
      // 屏蔽 AMD 显卡片段，避免显存数字被当成内存。
      spans.push({ start: amd.index, end: amd.index + amd[0].length });
    }
    flags.push("AMD 显卡不在表1（表1仅N卡），未计价");
  } else {
    const hint = source.match(/(?:rtx|gtx)\s?(\d{3,4})\s?(?:ti\s?super|tis|ti|super|s)?\s?(?:\d{1,2}\s?G)?/i);
    if (hint) {
      spans.push({ start: hint.index, end: hint.index + hint[0].length });
      flags.push(`显卡 ${hint[1]} 不在表1（未收录/私聊档）`);
    }
  }

  // --- CPU ---------------------------------------------------------------
  {
    const intel = findIntelCpu(source, intelTable);
    const ryzen = intel ? null : findRyzenCpu(source, cpuTable);
    const old = intel || ryzen ? null : findAthlonOld(source, cpuTable);
    const cpu = intel ?? ryzen ?? old;
    if (cpu) {
      if (cpu.span) {
        spans.push(cpu.span);
      }
      const notes = [];
      let status = "ok";
      if (cpu.price === null) {
        status = "unpriced";
        notes.push(intel ? "Intel CPU 表3待录入" : "表中暂无此型号价");
      } else if (cpu.low) {
        status = "low";
        notes.push("低置信价（待校对）");
      } else {
        notes.push("表2");
      }
      parts.push({ type: "cpu", label: cpu.label, price: cpu.price ?? 0, status, notes });
    }
  }

  // --- Storage -----------------------------------------------------------
  const storage = findStorage(source);
  if (storage) {
    spans.push(storage.span);
    const notes = [];
    if (storage.kind === "mechanical") {
      excluded.push("机械硬盘");
    } else {
      const item = Array.isArray(storageTable.items)
        ? storageTable.items.find((row) => Number(String(row?.model ?? "").replace(/[^\d]/g, "")) === storage.size || String(row?.model ?? "").includes(String(storage.size)))
        : null;
      if (item && Number.isFinite(Number(item.price))) {
        parts.push({
          type: "storage",
          label: storage.label,
          price: Number(item.price),
          status: item.low ? "low" : "ok",
          notes: ["表3 · SATA固态档"]
        });
      } else {
        parts.push({
          type: "storage",
          label: storage.label,
          price: 0,
          status: "unpriced",
          notes: [storage.kind === "nvme" ? "NVMe 不在表内（表3为SATA档）" : "固态档位待录入"]
        });
      }
      if (notes.length) {
        excluded.push(...notes);
      }
    }
  }

  // --- RAM ---------------------------------------------------------------
  const masked = maskSpans(source, spans);
  const ram = findRam(masked);
  if (ram) {
    const ddrMatch = masked.match(/ddr\s?([345])/i);
    const ddr = ddrMatch ? `DDR${ddrMatch[1]}` : "DDR4";
    if (!ddrMatch) {
      flags.push("内存代数未标明，按 DDR4 估");
    }
    const item = lookupMemory(memoryTable, "desktop", ddr, ram.per);
    if (item && Number.isFinite(Number(item.price))) {
      parts.push({
        type: "ram",
        label: `${ddr} ${ram.per}G${ram.count > 1 ? `×${ram.count}` : ""}`,
        price: Number(item.price) * ram.count,
        status: item.low ? "low" : "ok",
        notes: ["表2", ram.explicit ? "" : "条数未明，按单条估"].filter(Boolean)
      });
    } else {
      parts.push({
        type: "ram",
        label: `${ddr} ${ram.per}G${ram.count > 1 ? `×${ram.count}` : ""}`,
        price: 0,
        status: "unpriced",
        notes: ["内存价待录入（表2）"]
      });
    }
  }

  // --- Context notes -------------------------------------------------------
  const meaningful = parts.filter((part) => part.status !== "excluded");
  const foundTypes = new Set(meaningful.map((part) => part.type));
  const machineWord = MACHINE_WORDS.test(source);
  const kind = (machineWord || foundTypes.size >= 2) && (foundTypes.has("cpu") || foundTypes.has("gpu"))
    ? "machine"
    : "single";

  if (NUCLEAR_GRAPHICS.test(source)) {
    excluded.push("核显/亮机卡（无独显）");
  }
  if (/主板/.test(source)) {
    excluded.push("主板");
  }
  if (/电源/.test(source)) {
    excluded.push("电源");
  }
  if (/机箱/.test(source)) {
    excluded.push("机箱");
  }
  if (/散热|水冷|风冷|风扇/.test(source)) {
    excluded.push("散热/风扇");
  }
  if (/显示器|曲面屏/.test(source)) {
    excluded.push("显示器");
  }
  if (NOTEBOOK_WORDS.test(source)) {
    flags.push("疑似笔记本整机（本期范围仅台式）");
  }
  const risks = new Set();
  for (const match of source.matchAll(RISK_WORDS)) {
    const prefix = source.slice(Math.max(0, match.index - 3), match.index);
    if (/(?:无|非|未|没|不|拒绝|不是|没有)[\s、，和与]*$/.test(prefix)) {
      continue;
    }
    risks.add(match[0]);
  }
  if (risks.size) {
    flags.push(`风险词：${[...risks].join("、")}`);
  }
  if (gpuTable.verified !== true) {
    flags.push("显卡表未校对");
  }
  if (cpuTable.verified !== true && parts.some((part) => part.type === "cpu")) {
    flags.push("AMD表未校对");
  }
  if (intelTable.verified !== true && parts.some((part) => part.type === "cpu" && part.notes.some((note) => note.includes("Intel")))) {
    flags.push("Intel表待录入");
  }
  if (memoryTable.verified !== true && parts.some((part) => part.type === "ram" && part.price > 0)) {
    flags.push("内存表未校对");
  }

  // --- Totals & decision ----------------------------------------------------
  const sum = round2(parts.reduce((total, part) => total + (part.price > 0 ? part.price : 0), 0));
  const tolerance = kind === "machine" ? config.toleranceMachine : config.toleranceSingle;
  const price = Number.isFinite(sellerPrice) && sellerPrice > 0 ? sellerPrice : null;
  const rangeOk = kind !== "machine" || sum <= 0
    ? true
    : (sum >= config.machineMinSum && sum <= config.machineMaxSum);
  if (kind === "machine" && sum > 0 && !rangeOk) {
    flags.push(`整机估价 ${sum} 元超出收购范围（${config.machineMinSum}–${config.machineMaxSum} 元），不收`);
  }
  let diff = null;
  let inWindow = null;
  let direction = "";
  if (price !== null && sum > 0) {
    diff = round2(price - sum);
    inWindow = Math.abs(diff) <= tolerance && rangeOk;
    direction = diff === 0 ? "持平" : diff < 0 ? `卖家低于表价 ${Math.abs(diff)}` : `卖家高于表价 ${diff}`;
  }
  const missing = parts.filter((part) => part.status === "unpriced").map((part) => part.label);

  return {
    kind,
    text: source,
    parts,
    sum,
    missing,
    excluded,
    flags,
    sellerPrice: price,
    diff,
    direction,
    tolerance,
    windowLow: sum > 0 ? round2(sum - tolerance) : null,
    windowHigh: sum > 0 ? round2(sum + tolerance) : null,
    machineRange: { min: config.machineMinSum, max: config.machineMaxSum, ok: rangeOk },
    inWindow
  };
}

// ---------------------------------------------------------------------------
// Tables: load / sanitize / save
// ---------------------------------------------------------------------------

function sanitizeString(value, maxLength) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function sanitizeItemList(list) {
  if (!Array.isArray(list)) {
    return [];
  }
  const output = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const model = sanitizeString(raw.model, 60);
    const price = Number(raw.price);
    if (!model || !Number.isFinite(price) || price < 0 || price > 10_000_000) {
      continue;
    }
    const item = { model, price: round2(price) };
    const suffix = sanitizeString(raw.suffix, 8).toUpperCase();
    if (suffix) {
      item.suffix = suffix;
    }
    const vram = sanitizeString(raw.vram, 8).toUpperCase();
    if (vram) {
      item.vram = vram;
    }
    if (raw.low === true) {
      item.low = true;
    }
    const note = sanitizeString(raw.note, 120);
    if (note) {
      item.note = note;
    }
    output.push(item);
  }
  return output;
}

function sanitizeTable(raw, keys = ["items"]) {
  const source = raw && typeof raw === "object" ? raw : {};
  const table = {
    source: sanitizeString(source.source, 200),
    verified: source.verified === true
  };
  if (source.pending === true) {
    table.pending = true;
  }
  const note = sanitizeString(source.note, 500);
  if (note) {
    table.note = note;
  }
  if (Array.isArray(source.columns)) {
    table.columns = source.columns.map((column) => sanitizeString(column, 40)).slice(0, 20);
  }
  for (const key of keys) {
    table[key] = sanitizeItemList(source[key]);
  }
  return table;
}

export function sanitizeTables(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const gpu = sanitizeTable(source.gpu);
  const brandSource = source.gpu?.brandRule && typeof source.gpu.brandRule === "object" ? source.gpu.brandRule : {};
  const firstTier = Array.isArray(brandSource.firstTier)
    ? brandSource.firstTier.map((brand) => sanitizeString(brand, 24)).filter(Boolean).slice(0, 30)
    : [];
  const range = Array.isArray(brandSource.otherBrandDiscountRange) ? brandSource.otherBrandDiscountRange : [];
  gpu.brandRule = {
    firstTier: firstTier.length ? firstTier : FIRST_TIER_FALLBACK.slice(),
    otherBrandDiscountRange: [
      clampInteger(range[0], 0, 5000, 10),
      clampInteger(range[1], 0, 5000, 100)
    ]
  };
  return {
    version: 1,
    updatedAt: sanitizeString(source.updatedAt, 40),
    verified: source.verified === true,
    notes: Array.isArray(source.notes) ? source.notes.map((note) => sanitizeString(note, 300)).slice(0, 20) : [],
    gpu,
    cpu: sanitizeTable(source.cpu),
    intelCpu: sanitizeTable(source.intelCpu),
    xeon: sanitizeTable(source.xeon),
    memory: sanitizeTable(source.memory, ["desktop", "laptop", "server"]),
    storage: sanitizeTable(source.storage)
  };
}

export class Appraiser {
  constructor(database, { filePath } = {}) {
    this.database = database;
    this.filePath = filePath ?? resolve(process.cwd(), "data", "price-tables.json");
    this.cache = null;
    this.cacheAt = 0;
  }

  settings() {
    let stored = null;
    try {
      stored = JSON.parse(this.database.getSetting("appraisal") ?? "null");
    } catch {
      stored = null;
    }
    return normalizeAppraisal(stored ?? {});
  }

  tables({ force = false } = {}) {
    if (!force && this.cache && Date.now() - this.cacheAt < 10_000) {
      return this.cache;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
      this.cache = sanitizeTables(parsed);
    } catch {
      this.cache ??= sanitizeTables({});
    }
    this.cacheAt = Date.now();
    return this.cache;
  }

  reload() {
    this.cache = null;
    this.cacheAt = 0;
  }

  updateTables(input) {
    const sanitized = sanitizeTables(input ?? {});
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    writeFileSync(temporary, JSON.stringify(sanitized, null, 2), "utf8");
    renameSync(temporary, this.filePath);
    this.reload();
    return this.tables({ force: true });
  }

  appraise(text, sellerPrice = null) {
    const price = Number.isFinite(Number(sellerPrice)) && Number(sellerPrice) > 0 ? Number(sellerPrice) : null;
    return appraiseText(this.tables(), text, price, this.settings());
  }
}
