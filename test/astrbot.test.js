import test from "node:test";
import assert from "node:assert/strict";
import { AstrBotNotifier, normalizeAstrBotBaseUrl } from "../src/astrbot.js";
import { MonitorDatabase } from "../src/db.js";

test("AstrBot notifier sends an IM message through the configured OneBot bot", async () => {
  const database = new MonitorDatabase(":memory:");
  database.updateSettings({
    astrbotBaseUrl: "http://127.0.0.1:6185/",
    astrbotApiKey: "abk_test",
    astrbotBotId: "napcat-qq",
    astrbotReceiverQq: "123456"
  });
  let received;

  const notifier = new AstrBotNotifier(database, {
    fetchImpl: async (url, options) => {
      received = { url, options, body: JSON.parse(options.body) };
      return {
        ok: true,
        status: 200,
        async json() {
          return { status: "ok", data: null };
        }
      };
    }
  });

  await notifier.sendMessage("测试消息");
  assert.equal(received.url, "http://127.0.0.1:6185/api/v1/im/messages");
  assert.equal(received.options.headers.authorization, "Bearer abk_test");
  assert.deepEqual(received.body, {
    umo: "napcat-qq:FriendMessage:123456",
    message: "测试消息"
  });
  database.close();
});

test("AstrBot base URL removes trailing slashes and rejects invalid URLs", () => {
  assert.equal(normalizeAstrBotBaseUrl("http://127.0.0.1:6185///"), "http://127.0.0.1:6185");
  assert.throws(() => normalizeAstrBotBaseUrl("localhost:6185"), /http/);
});
