const state = {
  categories: [],
  rules: [],
  listings: [],
  blockedListings: [],
  aiRejections: [],
  status: null,
  editingRuleId: null,
  aiEnabled: false,
  aiSettingsDirty: false,
  aiSettingsRevision: 0,
  browserNetworkDirty: false,
  astrbotSettingsDirty: false,
  pacingDirty: false,
  appraisalDirty: false,
  priceTables: null,
  savingAiSettings: false
};

const $ = (selector) => document.querySelector(selector);

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatCurrency(value) {
  return `${Number(value ?? 0).toLocaleString("zh-CN", {
    maximumFractionDigits: 2
  })} 元`;
}

function formatPriceRange(minimum, maximum) {
  const lower = minimum === null || minimum === undefined ? 0 : minimum;
  return `${formatCurrency(lower)} - ${formatCurrency(maximum)}`;
}

function formatTime(value) {
  if (!value) {
    return "-";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(new Date(value));
}

function categoryLabel(value) {
  return state.categories.find((category) => category.value === value)?.label ?? "自定义";
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers ?? {})
    }
  });
  if (response.status === 204) {
    return null;
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || "请求失败");
  }
  return body;
}

let toastTimer;
function toast(message, error = false) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.toggle("error", error);
  element.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("show"), 3_500);
}

function setButtonLoading(button, active) {
  button.disabled = active;
  button.dataset.loading = String(active);
  button.dataset.originalText ||= button.textContent;
  button.textContent = active ? "处理中..." : button.dataset.originalText;
}

function renderStatus(status) {
  state.status = status;
  const monitor = $("#monitor-state");
  monitor.textContent = status.running ? "监控运行中" : "监控未启动";
  monitor.classList.toggle("running", status.running);
  $("#start-monitor").disabled = status.running;
  $("#stop-monitor").disabled = !status.running;

  const browser = status.browser;
  $("#browser-name").textContent = browser.browserName || "浏览器";
  $("#browser-state").textContent = browser.available
    ? ({ verified: "已登录", waiting_for_login: "等待登录", waiting_for_verification: "等待验证" }[browser.state] ?? "未连接")
    : "未找到浏览器";
  $("#browser-message").textContent = browser.message || browser.executablePath || "-";
  $("#browser-network-state").textContent = `当前：${browser.network || "跟随系统代理"}`;
  $("#astrbot-state").textContent = status.astrbotConfigured ? "已配置" : "未配置";
  $("#astrbot-message").textContent = status.astrbotConfigured
    ? "AstrBot + NapCat QQ 私聊已启用"
    : "填写 AstrBot 地址、IM API Key、机器人 ID 和接收 QQ";
  $("#activity-state").textContent = status.accessPaused
    ? "已暂停"
    : status.activeRuleId
      ? "扫描中"
      : status.running
        ? "待扫描"
        : "已停止";
  $("#activity-message").textContent = status.lastActivity || "-";
  const nextRule = status.nextRuleName ? `下一条：${status.nextRuleName}` : "暂无已启用规则";
  const pacingLabel = status.scanWindowLabel ? `时段 ${status.scanWindowLabel}` : "";
  $("#search-schedule").textContent = status.accessPaused
    ? "自动查询已暂停（验证冷却或等待登录恢复）"
    : !status.running
      ? `自动查询未启动；启动后按节律查询（${pacingLabel}）`
      : status.scanResting
        ? `非扫描时段休息中（${pacingLabel}）${status.nextWindowLabel ? `；${status.nextWindowLabel} 继续` : ""}`
        : `按节律查询（${status.enabledRuleCount ?? 0} 条）；${pacingLabel}${status.observing ? "；低速观察期" : ""}；${nextRule}`;
  const resumeButton = $("#resume-monitor");
  const recoveryBusy = ["closing", "opening"].includes(status.recoveryState);
  resumeButton.disabled = !status.accessPaused || recoveryBusy || resumeButton.dataset.loading === "true";
  resumeButton.title = status.accessPaused
    ? "若程序还没有自动恢复，可人工完成登录或验证后点这里立即继续"
    : "当前没有因登录或验证暂停";
  $("#restart-login").disabled = !browser.available || Boolean(status.activeRuleId)
    || $("#restart-login").dataset.loading === "true";
  const switchButton = $("#switch-browser");
  switchButton.disabled = !browser.canSwitch || Boolean(status.activeRuleId)
    || switchButton.dataset.loading === "true";
  switchButton.title = browser.canSwitch
    ? `遇到验证时会自动切换到 ${browser.alternateBrowserName}；也可手动切换`
    : "未找到可用的备用浏览器";
  $("#access-recovery").textContent = status.accessPaused ? status.lastActivity
    : browser.state === "verified" ? "会话已验证，无待处理恢复任务"
      : browser.message || "尚未验证闲鱼会话";
  $("#search-frequency").textContent = "仅活跃时段扫描，间隔随机，每轮随机小休；深夜自动休息。";
  const pacingState = $("#pacing-state");
  if (pacingState) {
    pacingState.textContent = status.observing ? "低速观察期（验证恢复后 24 小时）" : "正常节律";
  }
}

function renderRules(rules) {
  state.rules = rules;
  const enabledRules = rules
    .filter((rule) => rule.enabled)
    .sort((left, right) => left.id - right.id);
  const scanWaiting = Boolean(state.status?.accessPaused || state.status?.activeRuleId);
  const scanTitle = state.status?.accessPaused
    ? "登录或验证暂停期间无法扫描；恢复后会自动继续"
    : "当前正在扫描其他规则";
  const enabledCount = enabledRules.length;
  $("#rule-count").textContent = `${rules.length} 条规则，${enabledCount} 条启用`;
  $("#rotation-estimate").textContent = enabledCount
    ? `将按顺序查询 ${enabledCount} 条启用规则；普通规则至少 600 秒、整机规则至少 900 秒，规则之间随机冷却 45–90 秒`
    : "暂无已启用规则";
  const body = $("#rules-body");
  if (!rules.length) {
    body.innerHTML = `<tr><td class="empty" colspan="7">还没有监控规则。</td></tr>`;
    return;
  }

  body.innerHTML = rules
    .map((rule) => {
      const waiting = scanWaiting;
      const order = enabledRules.findIndex((candidate) => candidate.id === rule.id);
      const filters = [
        rule.personalOnly ? "个人" : "不限卖家",
        rule.includeTerms.length ? `含 ${rule.includeTerms.join(" / ")}` : "",
        rule.excludeTerms.length ? `排 ${rule.excludeTerms.join(" / ")}` : ""
      ]
        .filter(Boolean)
        .join(" | ");
      return `
        <tr>
          <td><strong>${escapeHtml(rule.name)}</strong><small>${escapeHtml(categoryLabel(rule.category))} · ${rule.valuationMode === "desktop_host" || rule.kind === "machine" ? "整机估价" : "普通部件"}</small></td>
          <td>${escapeHtml(rule.keyword)}${order >= 0 ? `<small>按顺序第 ${order + 1} 位</small>` : ""}</td>
          <td>${rule.valuationMode === "desktop_host" || rule.kind === "machine"
            ? `估值上限 ${formatCurrency(rule.hostValuationCapCny ?? 5500)}<small>±${rule.valuationTolerancePercent ?? 15}% · ${rule.scanIntervalSeconds ?? 900} 秒</small>`
            : formatPriceRange(rule.minPriceCny, rule.maxPriceCny) + `<small>${rule.scanIntervalSeconds ?? 600} 秒</small>`}</td>
          <td>${escapeHtml(filters || "-")}</td>
          <td><span class="tag ${rule.enabled ? "on" : "off"}">${rule.enabled ? "已启用" : "已停用"}</span></td>
          <td>${rule.lastError ? `<small class="error-text">${escapeHtml(rule.lastError)}</small>` : `<small>${rule.lastScannedAt ? formatTime(rule.lastScannedAt) : "未扫描"}</small>`}</td>
          <td>
            <div class="row-actions">
              <button class="button" data-action="scan" data-id="${rule.id}" ${waiting ? "disabled" : ""} title="${waiting ? scanTitle : "立即扫描这条规则"}">扫描</button>
              <button class="button" data-action="edit" data-id="${rule.id}">编辑</button>
              <button class="button" data-action="toggle" data-id="${rule.id}">${rule.enabled ? "停用" : "启用"}</button>
              <button class="button" data-action="delete" data-id="${rule.id}">删除</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
}

function renderListings(listings) {
  state.listings = listings;
  const body = $("#listings-body");
  if (!listings.length) {
    body.innerHTML = `<tr><td class="empty" colspan="7">暂无符合价格规则的商品。</td></tr>`;
    return;
  }

  body.innerHTML = listings
    .map(
      (listing) => `
        <tr>
          <td><strong>${escapeHtml(listing.title)}</strong><small>${escapeHtml(listing.sellerName || "卖家信息未识别")}</small></td>
          <td>${escapeHtml(categoryLabel(listing.category))}<small>${escapeHtml(listing.ruleName)}</small></td>
          <td>${formatCurrency(listing.currentPrice)}${listing.valuationCny !== null && listing.valuationCny !== undefined
            ? `<small>回收估值 ${formatCurrency(listing.valuationCny)}</small>` : ""}</td>
          <td>${formatPriceRange(listing.minPriceCny, listing.maxPriceCny)}</td>
          <td>${formatTime(listing.lastSeenAt)}</td>
          <td><a href="${escapeHtml(listing.url)}" target="_blank" rel="noreferrer">打开商品</a></td>
          <td>
            <button
              class="button"
              data-action="block-listing"
              data-item-id="${escapeHtml(listing.itemId)}"
              title="屏蔽后不再显示或提醒此商品"
            >屏蔽</button>
          </td>
        </tr>
      `
    )
    .join("");
}

function renderBlockedListings(listings) {
  const body = $("#blocked-body");
  if (!listings.length) {
    body.innerHTML = `<tr><td class="empty" colspan="5">暂无已屏蔽商品。</td></tr>`;
    return;
  }

  body.innerHTML = listings
    .map(
      (listing) => `
        <tr>
          <td><strong>${escapeHtml(listing.title)}</strong><small>${escapeHtml(listing.sellerName || "卖家信息未识别")}</small></td>
          <td>${escapeHtml(listing.blockReason || "手动屏蔽")}</td>
          <td>${formatTime(listing.blockedAt)}</td>
          <td><a href="${escapeHtml(listing.url)}" target="_blank" rel="noreferrer">打开商品</a></td>
          <td>
            <button class="button" data-action="unblock-listing" data-item-id="${escapeHtml(listing.itemId)}">恢复</button>
          </td>
        </tr>
      `
    )
    .join("");
}

function renderAiRejections(rejections) {
  state.aiRejections = rejections;
  $("#ai-rejection-count").textContent = `最近 ${rejections.length} 条审核记录`;
  $("#ai-rejections-body").innerHTML = rejections.length
    ? rejections.map((review) => {
      const action = review.isBlocked ? "已屏蔽" : review.blocked ? "已解除屏蔽" : "仅过滤提醒";
      return `
        <tr>
          <td><strong>${escapeHtml(review.title)}</strong><small>${escapeHtml(review.ruleName)} | ${escapeHtml(review.sellerName || "卖家未知")}</small></td>
          <td>${formatCurrency(review.price)}</td>
          <td class="ai-reason">${escapeHtml(review.reason)}${review.evidence ? `<small>原文依据：${escapeHtml(review.evidence)}</small>` : ""}</td>
          <td><span class="tag ${review.isBlocked ? "blocked" : "pending"}">${action}</span><small><button
            class="button"
            data-action="restore-ai"
            data-item-id="${escapeHtml(review.itemId)}"
            title="删除这条审核结果；下次扫描重新按规则判断并提醒，AI 不会再自动过滤或屏蔽它"
          >恢复提醒</button></small></td>
          <td>${formatTime(review.reviewedAt)}</td>
          <td><a href="${escapeHtml(review.url)}" target="_blank" rel="noreferrer">打开商品</a></td>
        </tr>
      `;
    }).join("")
    : '<tr><td class="empty" colspan="6">暂无 AI 未通过记录。</td></tr>';
}

function renderNotifications(notifications) {
  const element = $("#notifications");
  if (!notifications.length) {
    element.innerHTML = `<p class="empty">暂无提醒记录。</p>`;
    return;
  }
  element.innerHTML = notifications
    .slice(0, 8)
    .map(
      (item) => `
        <div>
          <span class="tag ${escapeHtml(item.status)}">${escapeHtml(item.status)}</span>
          <p title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</p>
          <small>${item.attempts ? `${item.attempts} 次` : formatTime(item.createdAt)}</small>
        </div>
      `
    )
    .join("");
}

const PRICE_TABLE_SECTIONS = [
  { key: "gpu", list: "items", title: "显卡（表1 · 新鑫）" },
  { key: "cpu", list: "items", title: "AMD CPU（锐龙 + 老平台）" },
  { key: "intelCpu", list: "items", title: "Intel CPU（表3 · 明泰）" },
  { key: "memory", list: "desktop", title: "台式机内存（表2）" },
  { key: "memory", list: "laptop", title: "笔记本内存" },
  { key: "memory", list: "server", title: "服务器内存" },
  { key: "storage", list: "items", title: "固态硬盘（表3 · SATA档）" },
  { key: "xeon", list: "items", title: "至强 E5 / E3" }
];

function parseGpuModelInput(value) {
  const text = String(value ?? "").toUpperCase().replace(/\s+/g, " ").trim();
  const match = text.match(/^(\d{3,4})\s?(TIS|TI\s?SUPER|TI|S)?\s?(\d{1,2}\s?G)?$/);
  if (!match) {
    return null;
  }
  const item = { model: match[1] };
  let suffix = (match[2] ?? "").replace(/\s+/g, "");
  if (suffix) {
    item.suffix = suffix === "TISUPER" ? "TIS" : suffix;
  }
  if (match[3]) {
    item.vram = match[3].replace(/\s+/g, "").toUpperCase();
  }
  return item;
}

function renderPriceTables() {
  const container = $("#price-tables");
  if (!container) {
    return;
  }
  const tables = state.priceTables;
  if (!tables) {
    container.innerHTML = '<p class="empty">价格表加载中…</p>';
    return;
  }
  const seenKeys = new Set();
  container.innerHTML = PRICE_TABLE_SECTIONS.map((def, sectionIndex) => {
    const table = tables[def.key] ?? {};
    const items = Array.isArray(table[def.list]) ? table[def.list] : [];
    const showVerified = !seenKeys.has(def.key);
    seenKeys.add(def.key);
    const rows = items.map((item, index) => {
      const suffix = item.suffix ? String(item.suffix) : "";
      const vram = item.vram ? String(item.vram) : "";
      const label = `${String(item.model ?? "")}${suffix}${vram ? ` ${vram}` : ""}`;
      const attrs = [
        `data-index="${index}"`,
        `data-model="${escapeHtml(String(item.model ?? ""))}"`,
        suffix ? `data-suffix="${escapeHtml(suffix)}"` : "",
        vram ? `data-vram="${escapeHtml(vram)}"` : "",
        item.low ? 'data-low="1"' : "",
        item.note ? `data-note="${escapeHtml(String(item.note))}"` : ""
      ].filter(Boolean).join(" ");
      return `
        <tr ${attrs}>
          <td class="cell-model">${escapeHtml(label)}${item.low ? ` <span class="tag pending">低置信</span>` : ""}${item.note ? `<small>${escapeHtml(String(item.note))}</small>` : ""}</td>
          <td><input class="table-price" data-role="price" type="number" min="0" step="1" value="${Number(item.price ?? 0)}"></td>
          <td><button class="button" type="button" data-action="remove-row">删除</button></td>
        </tr>`;
    }).join("");
    return `
      <details class="price-table" data-section="${sectionIndex}">
        <summary>${escapeHtml(def.title)} · ${items.length} 条${table.verified === true ? " ✓已校对" : "（待校对）"}</summary>
        <div class="table-wrap">
          <table>
            <thead><tr><th>型号</th><th>价格（元）</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
            <tfoot>
              <tr>
                <td><input data-role="new-model" maxlength="40" placeholder="新增型号，例如 4070S / i5-13400F"></td>
                <td><input data-role="new-price" type="number" min="0" step="1" placeholder="价格"></td>
                <td><button class="button" type="button" data-action="add-row">添加</button></td>
              </tr>
            </tfoot>
          </table>
        </div>
        ${showVerified ? `<label class="check-label"><input data-role="verified" type="checkbox"${table.verified === true ? " checked" : ""}><span>已对照原图校对过这张表</span></label>` : ""}
      </details>`;
  }).join("");
  const stateLabel = $("#tables-state");
  if (stateLabel) {
    stateLabel.textContent = `价格表日期：${tables.updatedAt || "-"}；改完点“保存价格表”立即生效（行情变了随时改）。`;
  }
}

async function loadPriceTables() {
  state.priceTables = await request("/api/price-tables");
  renderPriceTables();
}

async function savePriceTables(button) {
  if (!state.priceTables) {
    toast("价格表尚未加载完成", true);
    return;
  }
  const payload = JSON.parse(JSON.stringify(state.priceTables));
  for (const details of document.querySelectorAll("#price-tables details.price-table")) {
    const def = PRICE_TABLE_SECTIONS[Number(details.dataset.section)];
    if (!def) {
      continue;
    }
    const target = payload[def.key] ?? (payload[def.key] = {});
    const items = [];
    for (const row of details.querySelectorAll("tbody tr")) {
      const price = Number(row.querySelector('[data-role="price"]')?.value);
      if (!Number.isFinite(price) || price < 0) {
        continue;
      }
      let item = { model: row.dataset.model ?? "" };
      if (row.dataset.suffix) {
        item.suffix = row.dataset.suffix;
      }
      if (row.dataset.vram) {
        item.vram = row.dataset.vram;
      }
      if (def.key === "gpu" && !row.dataset.suffix && !row.dataset.vram) {
        // 通过页面新增的显卡行（如“4070S”）拆成 型号+后缀 存表，估价引擎才能匹配。
        const parsed = parseGpuModelInput(item.model);
        if (parsed) {
          item = parsed;
        }
      }
      if (!item.model) {
        continue;
      }
      if (row.dataset.low === "1") {
        item.low = true;
      }
      if (row.dataset.note) {
        item.note = row.dataset.note;
      }
      item.price = price;
      items.push(item);
    }
    target[def.list] = items;
    const verifiedBox = details.querySelector('[data-role="verified"]');
    if (verifiedBox) {
      target.verified = verifiedBox.checked;
    }
  }
  if (button) {
    setButtonLoading(button, true);
  }
  try {
    state.priceTables = await request("/api/price-tables", {
      method: "PUT",
      body: JSON.stringify(payload)
    });
    renderPriceTables();
    toast("价格表已保存并立即生效。");
  } catch (error) {
    toast(error.message || "价格表保存失败", true);
  } finally {
    if (button) {
      setButtonLoading(button, false);
    }
  }
}

function renderAppraiseResult(result) {
  const container = $("#appraise-result");
  if (!container) {
    return;
  }
  const kindLabel = result.kind === "machine" ? "整机" : "单件";
  let verdict = "未命中（差值超出窗口）";
  let tagClass = "";
  if (result.sum <= 0) {
    verdict = "无法估价（没有查到表内价格）";
  } else if (result.inWindow === true) {
    verdict = "✓ 命中，会推送";
    tagClass = "on";
  } else if (result.machineRange && result.machineRange.ok === false) {
    verdict = `超出收购范围（${result.machineRange.min}~${result.machineRange.max} 元），不收`;
    tagClass = "pending";
  }
  const diffText = result.diff === null
    ? "—"
    : `${result.diff > 0 ? "+" : ""}${formatCurrency(result.diff)}`;
  const partsRows = result.parts.map((part) => `
    <li>
      <strong>${escapeHtml(part.label)}</strong>
      ${part.price > 0 ? formatCurrency(part.price) : '<span class="muted">未计价</span>'}
      ${part.notes?.length ? `<small>${escapeHtml(part.notes.join(" / "))}</small>` : ""}
    </li>`).join("");
  container.innerHTML = `
    <div class="appraise-summary">
      <span class="tag ${tagClass}">${verdict}</span>
      <strong>${kindLabel}｜表价合计 ${formatCurrency(result.sum)}</strong>
      ${result.sellerPrice !== null ? `<span>卖家价 ${formatCurrency(result.sellerPrice)}</span>` : ""}
      ${result.diff !== null ? `<span>净差 ${diffText}</span>` : ""}
      ${result.windowLow !== null ? `<span class="muted">对比窗口 ${formatCurrency(result.windowLow)} ~ ${formatCurrency(result.windowHigh)}</span>` : ""}
    </div>
    ${partsRows ? `<ul class="appraise-parts">${partsRows}</ul>` : ""}
    ${result.missing.length ? `<p class="muted">未计价：${escapeHtml(result.missing.join("、"))}</p>` : ""}
    ${result.excluded.length ? `<p class="muted">不计入：${escapeHtml([...new Set(result.excluded)].join("、"))}</p>` : ""}
    ${result.flags.length ? `<p class="muted">提示：${escapeHtml(result.flags.join("；"))}</p>` : ""}
  `;
}

async function refresh() {
  const aiRevision = state.aiSettingsRevision;
  const [status, rules, listings, blockedListings, notifications, settings, aiRejections] = await Promise.all([
    request("/api/status"),
    request("/api/rules"),
    request("/api/listings?limit=100"),
    request("/api/blocked-listings?limit=100"),
    request("/api/notifications?limit=100"),
    request("/api/settings"),
    request("/api/ai-rejections?limit=100")
  ]);
  renderStatus(status);
  renderRules(rules);
  renderListings(listings);
  state.blockedListings = blockedListings;
  renderBlockedListings(blockedListings);
  renderNotifications(notifications);
  renderAiRejections(aiRejections);
  // The 5s poll must not wipe unsaved edits in the QQ alert form.
  if (!state.astrbotSettingsDirty) {
    if (document.activeElement !== $("#astrbot-base-url")) {
      $("#astrbot-base-url").value = settings.astrbotBaseUrl || "http://127.0.0.1:6185";
    }
    if (document.activeElement !== $("#astrbot-bot-id")) {
      $("#astrbot-bot-id").value = settings.astrbotBotId || "";
    }
    if (document.activeElement !== $("#astrbot-qq")) {
      $("#astrbot-qq").value = settings.astrbotReceiverQq || "";
    }
  }
  if (!state.pacingDirty) {
    const pacing = settings.scanPacing ?? {};
    $("#pacing-window-start").value = pacing.windowStart || "09:00";
    $("#pacing-window-end").value = pacing.windowEnd || "23:00";
    $("#pacing-interval-min").value = String(pacing.intervalMinSec ?? 120);
    $("#pacing-interval-max").value = String(pacing.intervalMaxSec ?? 300);
    $("#pacing-daily-limit").value = String(pacing.dailyLimit ?? 120);
    $("#pacing-cooldown").value = String(pacing.cooldownMinutes ?? 120);
  }
  if (!state.appraisalDirty) {
    const appraisal = settings.appraisal ?? {};
    $("#appraisal-tolerance-machine").value = String(appraisal.toleranceMachine ?? 550);
    $("#appraisal-tolerance-single").value = String(appraisal.toleranceSingle ?? 550);
    $("#appraisal-min-sum").value = String(appraisal.machineMinSum ?? 1300);
    $("#appraisal-max-sum").value = String(appraisal.machineMaxSum ?? 7000);
    $("#appraisal-brand-discount").value = String(appraisal.otherBrandDiscount ?? 50);
    const label = $("#appraisal-state");
    if (label) {
      label.textContent = `窗口 ±${appraisal.toleranceMachine ?? 550} 元｜收购范围 ${appraisal.machineMinSum ?? 1300}~${appraisal.machineMaxSum ?? 7000} 元`;
    }
  }
  // Never overwrite a network choice the user is still editing: the 5s poll must
  // not reset the dropdown (it used to also disable the proxy address input).
  const proxySetting = settings.browserProxy || "";
  const networkIdle = !state.browserNetworkDirty
    && document.activeElement !== $("#browser-proxy-mode")
    && document.activeElement !== $("#browser-proxy-url");
  if (networkIdle) {
    const proxyMode = !proxySetting ? "system" : proxySetting.toLowerCase() === "direct" ? "direct" : "custom";
    $("#browser-proxy-mode").value = proxyMode;
    $("#browser-proxy-url").value = proxyMode === "custom" ? proxySetting : "";
  }
  // An older poll must not overwrite a toggle or an unsaved settings draft.
  if (aiRevision === state.aiSettingsRevision && !state.savingAiSettings) {
    renderAiEnabled(settings.aiEnabled === true);
    if (!state.aiSettingsDirty) {
      $("#ai-base-url").value = settings.aiBaseUrl || "http://127.0.0.1:11434/v1";
      $("#ai-model").value = settings.aiModel || "qwen2.5:7b";
    }
  }
  $("#ai-api-key").placeholder = settings.aiApiKeyConfigured
    ? "已保存 Key；留空则保持不变"
    : "本地模型可留空";
  $("#astrbot-api-key").placeholder = settings.astrbotApiKeyConfigured
    ? "已保存 Key；留空则保持不变"
    : "AstrBot IM API Key";
}

function renderAiEnabled(enabled) {
  state.aiEnabled = enabled;
  $("#ai-enabled").checked = enabled;
  $("#ai-review-state").textContent = enabled ? "已启用" : "未启用";
  $("#ai-review-state").classList.toggle("on", enabled);
}

async function saveAiSettings(values, { saveDraft = false } = {}) {
  if (state.savingAiSettings) {
    return;
  }
  const revision = ++state.aiSettingsRevision;
  state.savingAiSettings = true;
  const button = $("#ai-settings-form button[type='submit']");
  $("#ai-enabled").disabled = true;
  setButtonLoading(button, true);
  try {
    const settings = await request("/api/settings", { method: "PUT", body: JSON.stringify(values) });
    if (saveDraft) {
      if (revision === state.aiSettingsRevision) {
        state.aiSettingsDirty = false;
      }
      if ($("#ai-api-key").value === values.aiApiKey) {
        $("#ai-api-key").value = "";
      }
    }
    renderAiEnabled(settings.aiEnabled === true);
    toast(saveDraft ? "AI 设置已保存。" : settings.aiEnabled ? "AI 审核已启用。" : "AI 审核已关闭。");
  } catch (error) {
    renderAiEnabled(state.aiEnabled);
    toast(error.message || "AI 设置保存失败", true);
  } finally {
    state.aiSettingsRevision += 1;
    state.savingAiSettings = false;
    $("#ai-enabled").disabled = false;
    setButtonLoading(button, false);
    await refresh().catch(() => {});
  }
}

async function withAction(button, callback) {
  setButtonLoading(button, true);
  try {
    await callback();
    await refresh();
  } catch (error) {
    toast(error.message || "操作失败", error.message !== "AI 请求已取消");
    await refresh().catch(() => {});
  } finally {
    setButtonLoading(button, false);
    if (state.status) {
      renderStatus(state.status);
    }
  }
}

async function bootstrap() {
  state.categories = await request("/api/categories");
  $("#category").innerHTML = state.categories
    .map((category) => `<option value="${category.value}">${category.label}</option>`)
    .join("");

  const valuationMode = $("#valuation-mode");
  const desktopHint = $("#desktop-rule-hint");
  const hostCap = $("#host-valuation-cap");
  const tolerance = $("#valuation-tolerance-percent");
  const scanInterval = $("#scan-interval-seconds");
  const syncRuleMode = () => {
    const desktop = valuationMode.value === "desktop_host";
    desktopHint.hidden = !desktop;
    hostCap.disabled = !desktop;
    tolerance.disabled = !desktop;
    scanInterval.min = desktop ? "900" : "600";
    if (Number(scanInterval.value) < Number(scanInterval.min)) {
      scanInterval.value = scanInterval.min;
    }
    const keyword = $("#rule-form").elements.keyword;
    if (desktop && !keyword.value.trim()) {
      keyword.placeholder = "例如：台式主机 / 电脑整机 / 游戏主机";
    } else {
      keyword.placeholder = "例如：4070 super 显卡";
    }
  };
  valuationMode.addEventListener("change", syncRuleMode);
  syncRuleMode();

  $("#rule-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.submitter;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const payload = {
      name: form.get("name"),
      category: form.get("category"),
      keyword: form.get("keyword"),
      valuationMode: form.get("valuationMode"),
      hostValuationCapCny: form.get("hostValuationCapCny"),
      valuationTolerancePercent: form.get("valuationTolerancePercent"),
      scanIntervalSeconds: form.get("scanIntervalSeconds"),
      minPriceCny: form.get("minPriceCny"),
      maxPriceCny: form.get("maxPriceCny"),
      includeTerms: form.get("includeTerms"),
      excludeTerms: form.get("excludeTerms"),
      personalOnly: form.get("personalOnly") === "on",
      enabled: form.get("enabled") === "on"
    };
    await withAction(button, async () => {
      if (state.editingRuleId) {
        await request(`/api/rules/${state.editingRuleId}`, {
          method: "PUT",
          body: JSON.stringify(payload)
        });
        toast("规则已更新，并会重新建立基线。");
      } else {
        await request("/api/rules", { method: "POST", body: JSON.stringify(payload) });
        toast("规则已添加。");
      }
      formElement.reset();
      formElement.querySelector('[name="minPriceCny"]').value = "0";
      formElement.querySelector('[name="valuationMode"]').value = "component";
      formElement.querySelector('[name="hostValuationCapCny"]').value = "5500";
      formElement.querySelector('[name="valuationTolerancePercent"]').value = "15";
      formElement.querySelector('[name="scanIntervalSeconds"]').value = "600";
      formElement.querySelector('[name="personalOnly"]').checked = true;
      formElement.querySelector('[name="enabled"]').checked = true;
      syncRuleMode();
      state.editingRuleId = null;
      $("#save-rule").textContent = "添加规则";
    });
  });

  $("#rules-body").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) {
      return;
    }
    const id = Number(button.dataset.id);
    const rule = state.rules.find((candidate) => candidate.id === id);
    if (!rule) {
      return;
    }

    await withAction(button, async () => {
      if (button.dataset.action === "scan") {
        const result = await request(`/api/rules/${id}/scan`, { method: "POST" });
        if (result.scanned === false) {
          toast(result.reason, true);
        } else {
          toast(
            result.baseline
              ? "首次扫描已建立基线，现有商品不会误发提醒。"
              : `扫描完成：低价匹配 ${result.matched} 个，已见未提醒 ${result.alreadySeen} 个，新增提醒 ${result.queued} 个${result.blocked ? `，已屏蔽 ${result.blocked} 个` : ""}。`
          );
        }
      }
      if (button.dataset.action === "edit") {
        const formElement = $("#rule-form");
        formElement.elements.name.value = rule.name;
        formElement.elements.category.value = rule.category;
        formElement.elements.keyword.value = rule.keyword;
        formElement.elements.valuationMode.value = rule.valuationMode || (rule.kind === "machine" ? "desktop_host" : "component");
        formElement.elements.hostValuationCapCny.value = rule.hostValuationCapCny ?? 5500;
        formElement.elements.valuationTolerancePercent.value = rule.valuationTolerancePercent ?? 15;
        formElement.elements.scanIntervalSeconds.value = rule.scanIntervalSeconds ?? (rule.kind === "machine" ? 900 : 600);
        syncRuleMode();
        formElement.elements.minPriceCny.value = rule.minPriceCny ?? 0;
        formElement.elements.maxPriceCny.value = rule.maxPriceCny;
        formElement.elements.includeTerms.value = rule.includeTerms.join(", ");
        formElement.elements.excludeTerms.value = rule.excludeTerms.join(", ");
        formElement.elements.personalOnly.checked = rule.personalOnly;
        formElement.elements.enabled.checked = rule.enabled;
        state.editingRuleId = rule.id;
        $("#save-rule").textContent = "保存修改";
        formElement.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      if (button.dataset.action === "toggle") {
        await request(`/api/rules/${id}`, {
          method: "PUT",
          body: JSON.stringify({ ...rule, enabled: !rule.enabled })
        });
      }
      if (button.dataset.action === "delete") {
        if (!confirm(`删除规则“${rule.name}”？相关商品记录和提醒记录也会删除。`)) {
          return;
        }
        await request(`/api/rules/${id}`, { method: "DELETE" });
        toast("规则已删除。");
      }
    });
  });

  $("#listings-body").addEventListener("click", async (event) => {
    const button = event.target.closest('button[data-action="block-listing"]');
    if (!button) {
      return;
    }
    const listing = state.listings?.find((candidate) => candidate.itemId === button.dataset.itemId);
    const row = button.closest("tr");
    const title = listing?.title || row?.querySelector("strong")?.textContent || "这个商品";
    const url = listing?.url || row?.querySelector("a")?.href || "";
    const sellerName = listing?.sellerName || row?.querySelector("td small")?.textContent || "";
    if (!confirm(`屏蔽“${title}”？以后不会再显示或提醒这个商品。`)) {
      return;
    }
    await withAction(button, async () => {
      await request("/api/blocked-listings", {
        method: "POST",
        body: JSON.stringify({
          itemId: button.dataset.itemId,
          title,
          url,
          sellerName
        })
      });
      toast("商品已屏蔽。");
    });
  });

  $("#blocked-body").addEventListener("click", async (event) => {
    const button = event.target.closest('button[data-action="unblock-listing"]');
    if (!button) {
      return;
    }
    await withAction(button, async () => {
      await request(`/api/blocked-listings/${encodeURIComponent(button.dataset.itemId)}`, {
        method: "DELETE"
      });
      toast("商品已恢复监控；AI 不会再自动过滤或屏蔽它。");
    });
  });

  $("#ai-rejections-body").addEventListener("click", async (event) => {
    const button = event.target.closest('button[data-action="restore-ai"]');
    if (!button) {
      return;
    }
    const row = button.closest("tr");
    const title = row?.querySelector("strong")?.textContent || "这个商品";
    if (!confirm(`恢复“${title}”的提醒？删除这条审核结果后，下次扫描会重新按规则判断并提醒。`)) {
      return;
    }
    await withAction(button, async () => {
      await request(`/api/ai-rejections/${encodeURIComponent(button.dataset.itemId)}/restore`, {
        method: "POST"
      });
      toast("已恢复提醒；下次扫描会重新按规则提醒。");
    });
  });

  $("#settings-form").addEventListener("input", () => {
    state.astrbotSettingsDirty = true;
  });

  $("#settings-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.submitter;
    const form = new FormData(event.currentTarget);
    await withAction(button, async () => {
      await request("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          astrbotBaseUrl: form.get("astrbotBaseUrl"),
          astrbotApiKey: form.get("astrbotApiKey"),
          astrbotBotId: form.get("astrbotBotId"),
          astrbotReceiverQq: form.get("astrbotReceiverQq")
        })
      });
      state.astrbotSettingsDirty = false;
      $("#astrbot-api-key").value = "";
      toast("QQ 提醒设置已保存。");
    });
  });

  $("#pacing-form").addEventListener("input", () => {
    state.pacingDirty = true;
  });

  $("#pacing-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    await withAction(event.submitter, async () => {
      await request("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          scanPacing: {
            windowStart: $("#pacing-window-start").value,
            windowEnd: $("#pacing-window-end").value,
            intervalMinSec: Number($("#pacing-interval-min").value),
            intervalMaxSec: Number($("#pacing-interval-max").value),
            dailyLimit: Number($("#pacing-daily-limit").value),
            cooldownMinutes: Number($("#pacing-cooldown").value)
          }
        })
      });
      state.pacingDirty = false;
      toast("扫描节律已保存。");
    });
  });

  $("#appraise-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.submitter;
    const text = $("#appraise-text").value.trim();
    if (!text) {
      toast("请先粘贴商品标题或描述", true);
      return;
    }
    const rawPrice = Number($("#appraise-price").value);
    setButtonLoading(button, true);
    try {
      const result = await request("/api/appraise", {
        method: "POST",
        body: JSON.stringify({
          text,
          price: Number.isFinite(rawPrice) && rawPrice > 0 ? rawPrice : null
        })
      });
      renderAppraiseResult(result);
    } catch (error) {
      toast(error.message || "估价失败", true);
    } finally {
      setButtonLoading(button, false);
    }
  });

  $("#appraisal-form").addEventListener("input", () => {
    state.appraisalDirty = true;
  });

  $("#appraisal-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    await withAction(event.submitter, async () => {
      await request("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          appraisal: {
            toleranceMachine: Number($("#appraisal-tolerance-machine").value),
            toleranceSingle: Number($("#appraisal-tolerance-single").value),
            machineMinSum: Number($("#appraisal-min-sum").value),
            machineMaxSum: Number($("#appraisal-max-sum").value),
            otherBrandDiscount: Number($("#appraisal-brand-discount").value)
          }
        })
      });
      state.appraisalDirty = false;
      toast("估价参数已保存。");
    });
  });

  $("#save-tables").addEventListener("click", (event) => savePriceTables(event.currentTarget));
  $("#reload-tables").addEventListener("click", (event) =>
    withAction(event.currentTarget, async () => {
      await loadPriceTables();
      toast("已重新加载价格表。");
    })
  );
  $("#price-tables").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) {
      return;
    }
    const details = button.closest("details.price-table");
    if (!details) {
      return;
    }
    if (button.dataset.action === "add-row") {
      const modelInput = details.querySelector('[data-role="new-model"]');
      const priceInput = details.querySelector('[data-role="new-price"]');
      const model = modelInput.value.trim();
      const price = Number(priceInput.value);
      if (!model || !Number.isFinite(price) || price < 0) {
        toast("请填写型号和正确的价格", true);
        return;
      }
      const row = document.createElement("tr");
      row.dataset.model = model;
      row.innerHTML = `
        <td class="cell-model">${escapeHtml(model)} <span class="tag pending">新增</span></td>
        <td><input class="table-price" data-role="price" type="number" min="0" step="1" value="${price}"></td>
        <td><button class="button" type="button" data-action="remove-row">删除</button></td>`;
      details.querySelector("tbody").appendChild(row);
      modelInput.value = "";
      priceInput.value = "";
      toast("已添加一行，记得点“保存价格表”。");
      return;
    }
    if (button.dataset.action === "remove-row") {
      button.closest("tr")?.remove();
    }
  });

  $("#browser-network-form").addEventListener("input", () => {
    state.browserNetworkDirty = true;
  });

  $("#browser-network-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const mode = $("#browser-proxy-mode").value;
    const proxyUrl = $("#browser-proxy-url").value.trim();
    if (mode === "custom" && !proxyUrl) {
      toast("请填写代理地址，例如 http://127.0.0.1:7890", true);
      $("#browser-proxy-url").focus();
      return;
    }
    await withAction(event.submitter, async () => {
      await request("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          browserProxy: mode === "system" ? "" : mode === "direct" ? "direct" : proxyUrl
        })
      });
      state.browserNetworkDirty = false;
      toast("网络出口已保存；点“关闭浏览器”再“打开登录”后生效。");
    });
  });

  $("#ai-settings-form").addEventListener("input", (event) => {
    if (event.target.id !== "ai-enabled") {
      state.aiSettingsDirty = true;
      state.aiSettingsRevision += 1;
    }
  });
  $("#ai-enabled").addEventListener("change", (event) =>
    saveAiSettings({ aiEnabled: event.target.checked })
  );
  $("#ai-settings-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await saveAiSettings({
      aiEnabled: form.get("aiEnabled") === "on",
      aiBaseUrl: form.get("aiBaseUrl"),
      aiApiKey: form.get("aiApiKey"),
      aiModel: form.get("aiModel")
    }, { saveDraft: true });
  });


  $("#start-monitor").addEventListener("click", (event) =>
    withAction(event.currentTarget, async () => {
      await request("/api/monitor/start", { method: "POST" });
      toast("监控已启动。");
    })
  );
  $("#stop-monitor").addEventListener("click", (event) =>
    withAction(event.currentTarget, async () => {
      await request("/api/monitor/stop", { method: "POST" });
      toast("监控已停止。");
    })
  );
  $("#open-login").addEventListener("click", (event) =>
    withAction(event.currentTarget, async () => {
      await request("/api/browser/login", { method: "POST" });
      toast("浏览器已打开。");
    })
  );
  $("#verify-login").addEventListener("click", (event) =>
    withAction(event.currentTarget, async () => {
      const browser = await request("/api/browser/verify", { method: "POST" });
      toast(browser.state === "verified" ? "闲鱼登录已验证。" : browser.message, browser.state !== "verified");
    })
  );
  $("#restart-login").addEventListener("click", (event) =>
    withAction(event.currentTarget, async () => {
      const status = await request("/api/browser/restart-login", { method: "POST" });
      toast(status.lastActivity);
    })
  );
  $("#switch-browser").addEventListener("click", (event) =>
    withAction(event.currentTarget, async () => {
      const status = await request("/api/browser/switch", { method: "POST" });
      toast(status.lastActivity);
    })
  );
  $("#resume-monitor").addEventListener("click", (event) =>
    withAction(event.currentTarget, async () => {
      const status = await request("/api/monitor/resume", { method: "POST" });
      toast(status.lastActivity);
    })
  );
  $("#close-browser").addEventListener("click", (event) =>
    withAction(event.currentTarget, async () => {
      await request("/api/browser/close", { method: "POST" });
      toast("浏览器已关闭。");
    })
  );
  $("#reset-profile").addEventListener("click", (event) => {
    const confirmed = confirm(
      "将清空本地浏览器资料（缓存、Cookie、登录状态），相当于换一台新设备，需要重新扫码登录。监控规则与提醒记录不受影响。继续吗？"
    );
    if (!confirmed) {
      return undefined;
    }
    return withAction(event.currentTarget, async () => {
      await request("/api/browser/reset-profile", { method: "POST" });
      toast("浏览器资料已清空；点“打开登录”重新扫码。");
    });
  });
  $("#test-astrbot").addEventListener("click", (event) =>
    withAction(event.currentTarget, async () => {
      await request("/api/settings/test-astrbot", { method: "POST" });
      toast("测试消息已发送。");
    })
  );
  $("#test-ai").addEventListener("click", (event) =>
    withAction(event.currentTarget, async () => {
      await request("/api/settings/test-ai", { method: "POST" });
      toast("AI 连接测试成功。");
    })
  );
  $("#retry-failed").addEventListener("click", (event) =>
    withAction(event.currentTarget, async () => {
      const result = await request("/api/notifications/retry-failed", { method: "POST" });
      toast(`已重新加入 ${result.retried} 条失败消息。`);
    })
  );

  await loadPriceTables().catch((error) => {
    const label = $("#tables-state");
    if (label) {
      label.textContent = error.message || "价格表加载失败";
    }
  });
  await refresh();
  setInterval(() => refresh().catch(() => {}), 5_000);
}

bootstrap().catch((error) => toast(error.message || "初始化失败", true));
