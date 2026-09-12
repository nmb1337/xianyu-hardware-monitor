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
