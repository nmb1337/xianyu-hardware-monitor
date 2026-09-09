const state = {
  categories: [],
  rules: [],
  listings: [],
  blockedListings: [],
  status: null,
  editingRuleId: null
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
  $("#browser-state").textContent = browser.available
    ? ({ verified: "已登录", waiting_for_login: "等待登录", waiting_for_verification: "等待验证" }[browser.state] ?? "未连接")
    : "未找到浏览器";
  $("#browser-message").textContent = browser.message || browser.executablePath || "-";
  $("#astrbot-state").textContent = status.astrbotConfigured ? "已配置" : "未配置";
  $("#astrbot-message").textContent = status.astrbotConfigured
    ? "AstrBot + NapCat QQ 私聊已启用"
    : "填写 AstrBot 地址、IM API Key、机器人 ID 和接收 QQ";
  $("#activity-state").textContent = status.activeRuleId ? "扫描中" : status.running ? "待扫描" : "已停止";
  $("#activity-message").textContent = status.lastActivity || "-";
}

function renderRules(rules) {
  state.rules = rules;
  $("#rule-count").textContent = `${rules.length} 条规则`;
  const body = $("#rules-body");
  if (!rules.length) {
    body.innerHTML = `<tr><td class="empty" colspan="7">还没有监控规则。</td></tr>`;
    return;
  }

  body.innerHTML = rules
    .map((rule) => {
      const filters = [
        rule.personalOnly ? "个人" : "不限卖家",
        rule.includeTerms.length ? `含 ${rule.includeTerms.join(" / ")}` : "",
        rule.excludeTerms.length ? `排 ${rule.excludeTerms.join(" / ")}` : ""
      ]
        .filter(Boolean)
        .join(" | ");
      return `
        <tr>
          <td><strong>${escapeHtml(rule.name)}</strong><small>${escapeHtml(categoryLabel(rule.category))}</small></td>
          <td>${escapeHtml(rule.keyword)}<small>${rule.scanIntervalSeconds} 秒 + 随机等待</small></td>
          <td>${formatPriceRange(rule.minPriceCny, rule.maxPriceCny)}</td>
          <td>${escapeHtml(filters || "-")}</td>
          <td><span class="tag ${rule.enabled ? "on" : "off"}">${rule.enabled ? "已启用" : "已停用"}</span></td>
          <td>${rule.lastError ? `<small class="error-text">${escapeHtml(rule.lastError)}</small>` : `<small>${rule.lastScannedAt ? formatTime(rule.lastScannedAt) : "未扫描"}</small>`}</td>
          <td>
            <div class="row-actions">
              <button class="button" data-action="scan" data-id="${rule.id}">扫描</button>
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
          <td>${formatCurrency(listing.currentPrice)}</td>
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
    body.innerHTML = `<tr><td class="empty" colspan="4">暂无已屏蔽商品。</td></tr>`;
    return;
  }

  body.innerHTML = listings
    .map(
      (listing) => `
        <tr>
          <td><strong>${escapeHtml(listing.title)}</strong><small>${escapeHtml(listing.sellerName || "卖家信息未识别")}</small></td>
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

async function refresh() {
  const [status, rules, listings, blockedListings, notifications, settings] = await Promise.all([
    request("/api/status"),
    request("/api/rules"),
    request("/api/listings?limit=100"),
    request("/api/blocked-listings?limit=100"),
    request("/api/notifications?limit=100"),
    request("/api/settings")
  ]);
  renderStatus(status);
  renderRules(rules);
  renderListings(listings);
  state.blockedListings = blockedListings;
  renderBlockedListings(blockedListings);
  renderNotifications(notifications);
  if (document.activeElement !== $("#astrbot-base-url")) {
    $("#astrbot-base-url").value = settings.astrbotBaseUrl || "http://127.0.0.1:6185";
  }
  if (document.activeElement !== $("#astrbot-bot-id")) {
    $("#astrbot-bot-id").value = settings.astrbotBotId || "";
  }
  if (document.activeElement !== $("#astrbot-qq")) {
    $("#astrbot-qq").value = settings.astrbotReceiverQq || "";
  }
  $("#astrbot-api-key").placeholder = settings.astrbotApiKeyConfigured
    ? "已保存 Key；留空则保持不变"
    : "AstrBot IM API Key";
}

async function withAction(button, callback) {
  setButtonLoading(button, true);
  try {
    await callback();
    await refresh();
  } catch (error) {
    toast(error.message || "操作失败", true);
  } finally {
    setButtonLoading(button, false);
  }
}

async function bootstrap() {
  state.categories = await request("/api/categories");
  $("#category").innerHTML = state.categories
    .map((category) => `<option value="${category.value}">${category.label}</option>`)
    .join("");

  $("#rule-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.submitter;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const payload = {
      name: form.get("name"),
      category: form.get("category"),
      keyword: form.get("keyword"),
      minPriceCny: form.get("minPriceCny"),
      maxPriceCny: form.get("maxPriceCny"),
      scanIntervalSeconds: form.get("scanIntervalSeconds"),
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
      formElement.querySelector('[name="scanIntervalSeconds"]').value = "120";
      formElement.querySelector('[name="personalOnly"]').checked = true;
      formElement.querySelector('[name="enabled"]').checked = true;
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
        toast(
          result.baseline
            ? "首次扫描已建立基线，现有商品不会误发提醒。"
            : `扫描完成：低价匹配 ${result.matched} 个，已见未提醒 ${result.alreadySeen} 个，新增提醒 ${result.queued} 个${result.blocked ? `，已屏蔽 ${result.blocked} 个` : ""}。`
        );
      }
      if (button.dataset.action === "edit") {
        const formElement = $("#rule-form");
        formElement.elements.name.value = rule.name;
        formElement.elements.category.value = rule.category;
        formElement.elements.keyword.value = rule.keyword;
        formElement.elements.minPriceCny.value = rule.minPriceCny ?? 0;
        formElement.elements.maxPriceCny.value = rule.maxPriceCny;
        formElement.elements.scanIntervalSeconds.value = rule.scanIntervalSeconds;
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
      toast("商品已恢复监控。");
    });
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
      $("#astrbot-api-key").value = "";
      toast("QQ 提醒设置已保存。");
    });
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
  $("#close-browser").addEventListener("click", (event) =>
    withAction(event.currentTarget, async () => {
      await request("/api/browser/close", { method: "POST" });
      toast("浏览器已关闭。");
    })
  );
  $("#test-astrbot").addEventListener("click", (event) =>
    withAction(event.currentTarget, async () => {
      await request("/api/settings/test-astrbot", { method: "POST" });
      toast("测试消息已发送。");
    })
  );
  $("#retry-failed").addEventListener("click", (event) =>
    withAction(event.currentTarget, async () => {
      const result = await request("/api/notifications/retry-failed", { method: "POST" });
      toast(`已重新加入 ${result.retried} 条失败消息。`);
    })
  );

  await refresh();
  setInterval(() => refresh().catch(() => {}), 5_000);
}

bootstrap().catch((error) => toast(error.message || "初始化失败", true));
