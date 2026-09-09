function normalize(value) {
  return String(value ?? "").trim().toLocaleLowerCase("zh-CN");
}

export function splitTerms(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((term) => String(term).trim()).filter(Boolean))];
  }

  return [
    ...new Set(
      String(value ?? "")
        .split(/[\n,，]/)
        .map((term) => term.trim())
        .filter(Boolean)
    )
  ];
}

export function parsePrice(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }

  const source = String(value ?? "").replace(/,/g, "").trim();
  if (!source || /面议|待定|咨询|免费|赠送/.test(source)) {
    return null;
  }

  const match = source.match(/(?:[¥￥]\s*)?(\d+(?:\.\d{1,2})?)/);
  if (!match) {
    return null;
  }

  const price = Number(match[1]);
  return Number.isFinite(price) && price >= 0 ? price : null;
}

export function evaluateListing(rule, listing) {
  const title = normalize(listing.title);
  const includeTerms = splitTerms(rule.includeTerms);
  const excludeTerms = splitTerms(rule.excludeTerms);
  const price = parsePrice(listing.price);
  const minimum = rule.minPriceCny === null || rule.minPriceCny === undefined || rule.minPriceCny === ""
    ? null
    : Number(rule.minPriceCny);
  const maximum = Number(rule.maxPriceCny ?? rule.priceCeilingCny);

  if (!title || price === null) {
    return { matched: false, eligible: false, reason: "标题或价格无法识别", price };
  }

  if (!Number.isFinite(maximum) || maximum <= 0) {
    return { matched: false, eligible: false, reason: "规则最高价无效", price };
  }

  if (minimum !== null && (!Number.isFinite(minimum) || minimum < 0 || minimum >= maximum)) {
    return { matched: false, eligible: false, reason: "规则最低价无效", price };
  }

  if (includeTerms.some((term) => !title.includes(normalize(term)))) {
    return { matched: false, eligible: false, reason: "未包含全部必需关键词", price };
  }

  if (excludeTerms.some((term) => title.includes(normalize(term)))) {
    return { matched: false, eligible: false, reason: "命中排除词", price };
  }

  if (rule.personalOnly && listing.isPersonal === false) {
    return { matched: false, eligible: false, reason: "非个人卖家", price };
  }

  if (minimum !== null && price < minimum) {
    return { matched: false, eligible: true, reason: "价格低于提醒下限", price };
  }

  if (price > maximum) {
    return { matched: false, eligible: true, reason: "价格高于提醒上限", price };
  }

  return { matched: true, eligible: true, reason: "符合规则", price };
}
