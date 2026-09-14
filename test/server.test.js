import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApplication } from "../src/server.js";

async function startApplication(t) {
  const app = createApplication({ databasePath: ":memory:" });
  t.after(async () => {
    if (app.server.listening) {
      await new Promise((resolve, reject) => {
        app.server.close((error) => error ? reject(error) : resolve());
        app.server.closeIdleConnections();
      });
    }
    await app.close();
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  return { ...app, baseUrl: `http://127.0.0.1:${app.server.address().port}` };
}

test("application starts without customer service and retains monitor and review controls", async (t) => {
  const { services, baseUrl } = await startApplication(t);
  assert.equal("customerService" in services, false);
  assert.ok(services.ai);
  assert.ok(services.notifier);

  const status = await fetch(`${baseUrl}/api/status`);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).running, false);

  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /id="ai-settings-form"/);
  assert.match(html, /id="test-astrbot"/);
  assert.doesNotMatch(html, /customer-service|aiCustomer|客服|自动回复/);
});

test("retired customer service endpoints return 404 even with legacy settings enabled", async (t) => {
  const { services, baseUrl } = await startApplication(t);
  services.database.setSetting("ai_customer_enabled", "1");
  services.database.setSetting("ai_customer_prompt", "Legacy instruction");

  for (const [path, options] of [
    ["/api/customer-service/conversations/example", {}],
    ["/api/customer-service/draft", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId: "example", message: "Hello" })
    }]
  ]) {
    const response = await fetch(`${baseUrl}${path}`, options);
    assert.equal(response.status, 404);
    assert.equal(typeof (await response.json()).error, "string");
  }
});

test("settings ignore retired customer fields while preserving AI review and QQ configuration", async (t) => {
  const { services, baseUrl } = await startApplication(t);
  const { database } = services;
  database.updateSettings({
    astrbotBaseUrl: "http://127.0.0.1:6185",
    astrbotApiKey: "fixture-notification-key",
    astrbotBotId: "fixture-bot",
    astrbotReceiverQq: "123456789",
    aiEnabled: true,
    aiBaseUrl: "http://127.0.0.1:11434/v1",
    aiApiKey: "fixture-review-key",
    aiModel: "fixture-model"
  });
  database.setSetting("ai_customer_enabled", "1");
  database.setSetting("ai_customer_prompt", "Legacy instruction");
  const settingsBefore = database.getPublicSettings();
  assert.equal("aiCustomerEnabled" in settingsBefore, false);
  assert.equal("aiCustomerPrompt" in settingsBefore, false);

  const updated = await fetch(`${baseUrl}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ aiCustomerEnabled: true, aiCustomerPrompt: "x".repeat(5000) })
  });
  assert.equal(updated.status, 200);
  assert.deepEqual(await updated.json(), settingsBefore);

  const fetched = await fetch(`${baseUrl}/api/settings`);
  assert.equal(fetched.status, 200);
  assert.deepEqual(await fetched.json(), settingsBefore);
  assert.equal(database.getSetting("ai_customer_prompt"), "Legacy instruction");
  assert.equal(database.getSetting("ai_api_key"), "fixture-review-key");
  assert.equal(database.getSetting("astrbot_api_key"), "fixture-notification-key");
  assert.equal(services.ai.configured(), true);
  assert.equal(services.notifier.configured(), true);
});

test("AI connection test reports sanitized relay errors and accepts compatible requests", async (t) => {
  const { services, baseUrl } = await startApplication(t);
  services.database.updateSettings({
    aiEnabled: true, aiBaseUrl: "https://relay.example/v1",
    aiModel: "fixture-model", aiApiKey: "fixture-private-key"
  });
  services.ai.options.fetchImpl = async () => Response.json({
    error: { message: "Model unavailable: fixture-private-key", param: "model" }
  }, { status: 400 });
  const failed = await fetch(`${baseUrl}/api/settings/test-ai`, { method: "POST" });
  assert.equal(failed.status, 400);
  const failure = await failed.json();
  assert.match(failure.error, /Model unavailable.*REDACTED.*param=model/);
  assert.doesNotMatch(failure.error, /fixture-private-key/);

  services.ai.options.fetchImpl = async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.equal("temperature" in request, false);
    const { candidates } = JSON.parse(request.messages[1].content);
    return Response.json({ choices: [{ message: { content: JSON.stringify({
      items: [{ itemId: candidates[0].itemId, notify: true, reason: "Test listing" }]
    }) } }] });
  };
  const succeeded = await fetch(`${baseUrl}/api/settings/test-ai`, { method: "POST" });
  assert.equal(succeeded.status, 200);
  assert.deepEqual(await succeeded.json(), { ok: true, reviewed: 1 });
});

test("disabling AI saves immediately and cancels an in-flight connection test", async (t) => {
  const { services, baseUrl } = await startApplication(t);
  services.database.updateSettings({
    aiEnabled: true, aiBaseUrl: "https://relay.example/v1",
    aiModel: "fixture-model", aiApiKey: "fixture-private-key"
  });
  let started;
  let relaySignal;
  const entered = new Promise((resolve) => { started = resolve; });
  services.ai.options.fetchImpl = (_url, options) => new Promise((_resolve, reject) => {
    relaySignal = options.signal;
    relaySignal.addEventListener("abort", () => reject(relaySignal.reason), { once: true });
    started();
  });
  const testing = fetch(`${baseUrl}/api/settings/test-ai`, { method: "POST" });
  await entered;
  const settingsBefore = services.database.getPublicSettings();
  const disabled = await fetch(`${baseUrl}/api/settings`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ aiEnabled: false })
  });
  assert.equal(disabled.status, 200);
  assert.deepEqual(await disabled.json(), { ...settingsBefore, aiEnabled: false });
  assert.equal(relaySignal.aborted, true);
  const cancelled = await testing;
  assert.equal(cancelled.status, 400);
  assert.deepEqual(await cancelled.json(), { error: "AI 请求已取消" });
  assert.equal(services.ai.pendingRequests.size, 0);
  assert.equal(services.database.getSetting("ai_api_key"), "fixture-private-key");
  const settings = await (await fetch(`${baseUrl}/api/settings`)).json();
  assert.equal(settings.aiEnabled, false);
});

test("restart-login endpoint delegates to the serialized monitor recovery workflow", async (t) => {
  const { services, baseUrl } = await startApplication(t);
  let calls = 0;
  services.monitor.restartLogin = async () => {
    calls += 1;
    return { accessPaused: true, recoveryState: "awaiting_human" };
  };
  const response = await fetch(`${baseUrl}/api/browser/restart-login`, { method: "POST" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { accessPaused: true, recoveryState: "awaiting_human" });
  assert.equal(calls, 1);
});

test("browser switch endpoint delegates to the paused recovery workflow", async (t) => {
  const { services, baseUrl } = await startApplication(t);
  let calls = 0;
  services.monitor.switchBrowser = async () => {
    calls += 1;
    return { accessPaused: true, recoveryState: "awaiting_human" };
  };
  const response = await fetch(`${baseUrl}/api/browser/switch`, { method: "POST" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { accessPaused: true, recoveryState: "awaiting_human" });
  assert.equal(calls, 1);
});

test("AI rejection endpoint exposes saved reasons without configuration secrets", async (t) => {
  const { services, baseUrl } = await startApplication(t);
  const rule = services.database.createRule({
    name: "GPU", category: "gpu", keyword: "GPU", priceCeilingCny: 1000,
    enabled: true, scanIntervalSeconds: 300
  });
  services.database.recordAiRejection(rule, {
    itemId: "accessory", title: "GPU box", price: 300,
    url: "https://www.goofish.com/item?id=accessory"
  }, { notify: false, reason: "Box only, no graphics card", evidence: "box" });
  const response = await fetch(`${baseUrl}/api/ai-rejections?limit=1`);
  assert.equal(response.status, 200);
  const reviews = await response.json();
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].reason, "Box only, no graphics card");
  assert.equal(reviews[0].evidence, "box");
  assert.equal(reviews[0].blocked, false);
  assert.doesNotMatch(JSON.stringify(reviews), /apiKey|authorization|ai_base_url/i);
});

test("restoring an AI rejection clears its block and exempts the item from AI", async (t) => {
  const { services, baseUrl } = await startApplication(t);
  const { database } = services;
  const rule = database.createRule({
    name: "GPU", category: "gpu", keyword: "GPU", priceCeilingCny: 1000, enabled: true
  });
  const listing = {
    itemId: "restore-me", title: "GPU box only", price: 300,
    url: "https://www.goofish.com/item?id=restore-me"
  };
  database.recordAiRejection(rule, listing, {
    notify: false, block: true, reason: "Only the box is included", evidence: "box", confidence: 0.95
  });
  database.blockListing({ ...listing, blockReason: "Only the box is included" });

  const restored = await fetch(`${baseUrl}/api/ai-rejections/restore-me/restore`, { method: "POST" });
  assert.equal(restored.status, 204);
  assert.deepEqual(database.listAiRejections(), []);
  assert.equal(database.isListingBlocked("restore-me"), false);
  assert.equal(database.isAiExempt("restore-me"), true);

  const missing = await fetch(`${baseUrl}/api/ai-rejections/restore-me/restore`, { method: "POST" });
  assert.equal(missing.status, 404);
  assert.equal(typeof (await missing.json()).error, "string");
});

for (const length of [500, 501, 6_000]) {
  test(`blocking preserves a ${length}-character title and cancels pending alerts`, async (t) => {
    const { services, baseUrl } = await startApplication(t);
    const { database } = services;
    const rule = database.createRule({
      name: "GPU", category: "gpu", keyword: "GPU", priceCeilingCny: 1000,
      enabled: true, scanIntervalSeconds: 300
    });
    const listing = {
      itemId: `long-title-${length}`, title: "长".repeat(length), price: 600,
      url: `https://www.goofish.com/item?id=long-title-${length}`, sellerName: "Test seller"
    };
    database.recordCandidateListing(rule, listing, 600, true, "Test alert");
    const response = await fetch(`${baseUrl}/api/blocked-listings`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(listing)
    });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).title, listing.title);
    assert.equal(database.isListingBlocked(listing.itemId), true);
    assert.deepEqual(database.listListings(), []);
    assert.equal(database.listNotifications()[0].status, "blocked");
    assert.equal(database.claimNextNotification(), null);
    const blocked = await (await fetch(`${baseUrl}/api/blocked-listings`)).json();
    assert.equal(blocked[0].itemId, listing.itemId);
    assert.equal(blocked[0].title, listing.title);

    const restored = await fetch(`${baseUrl}/api/blocked-listings/${listing.itemId}`, { method: "DELETE" });
    assert.equal(restored.status, 204);
    assert.equal(database.listListings()[0].title, listing.title);
    assert.equal(database.listNotifications()[0].status, "pending");
  });
}

test("blocking still rejects blank titles and oversized requests without saving them", async (t) => {
  const { services, baseUrl } = await startApplication(t);
  for (const [title, error] of [
    [" \n ", "商品标题不能为空"],
    ["长".repeat(43_000), "请求内容过大"]
  ]) {
    const response = await fetch(`${baseUrl}/api/blocked-listings`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemId: "invalid", title, url: "https://www.goofish.com/item?id=invalid" })
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error });
    assert.deepEqual(services.database.listBlockedListings(), []);
  }
});

test("rules save without a scan interval and the retired mode endpoint returns 404", async (t) => {
  const { baseUrl, services } = await startApplication(t);
  const created = await fetch(`${baseUrl}/api/rules`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "GPU", category: "gpu", keyword: "GPU", maxPriceCny: 1000, personalOnly: true, enabled: true
    })
  });
  assert.equal(created.status, 201);
  const rule = await created.json();
  assert.equal(rule.keyword, "GPU");
  assert.equal(services.database.enabledRulesInOrder().length, 1);

  const mode = await fetch(`${baseUrl}/api/monitor/mode`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "continuous" })
  });
  assert.equal(mode.status, 404);
  await mode.json();
});

test("settings accept multiple receiver QQ numbers and reject invalid lists", async (t) => {
  const { services, baseUrl } = await startApplication(t);
  services.database.updateSettings({
    astrbotBaseUrl: "http://127.0.0.1:6185",
    astrbotApiKey: "fixture-notification-key",
    astrbotBotId: "fixture-bot",
    astrbotReceiverQq: "123456789"
  });

  const saved = await fetch(`${baseUrl}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ astrbotReceiverQq: "123456789, 987654321;123456789" })
  });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).astrbotReceiverQq, "123456789, 987654321");
  assert.equal(services.database.getSetting("astrbot_receiver_qq"), "123456789, 987654321");
  assert.equal(services.notifier.configured(), true);

  const invalid = await fetch(`${baseUrl}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ astrbotReceiverQq: "123456789, abc" })
  });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /接收 QQ 号格式无效/);
  assert.equal(services.database.getSetting("astrbot_receiver_qq"), "123456789, 987654321");

  const tooMany = Array.from({ length: 11 }, (_, index) => String(200000000 + index)).join(",");
  const rejected = await fetch(`${baseUrl}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ astrbotReceiverQq: tooMany })
  });
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json()).error, /最多支持 10 个/);
});
