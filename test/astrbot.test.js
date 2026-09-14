import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { AstrBotNotifier, normalizeAstrBotBaseUrl, parseReceiverQqList } from "../src/astrbot.js";
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

test("receiver QQ parsing accepts separators, dedupes entries, and rejects invalid lists", () => {
  assert.deepEqual(parseReceiverQqList("123456, 654321;123456\n777777"), ["123456", "654321", "777777"]);
  assert.deepEqual(parseReceiverQqList("123456，654321、777777"), ["123456", "654321", "777777"]);
  assert.deepEqual(parseReceiverQqList(""), []);
  assert.deepEqual(parseReceiverQqList(null), []);
  assert.throws(() => parseReceiverQqList("123456, abc"), /格式无效/);
  assert.throws(() => parseReceiverQqList("1234"), /格式无效/);
  const tooMany = Array.from({ length: 11 }, (_, index) => String(200000000 + index)).join(",");
  assert.throws(() => parseReceiverQqList(tooMany), /最多支持 10 个/);
});

test("a malformed stored receiver value degrades to not configured instead of crashing", () => {
  const database = new MonitorDatabase(":memory:");
  database.updateSettings({
    astrbotBaseUrl: "http://127.0.0.1:6185",
    astrbotApiKey: "abk_test",
    astrbotBotId: "napcat-qq",
    astrbotReceiverQq: "abc"
  });
  const notifier = new AstrBotNotifier(database);
  assert.equal(notifier.configured(), false);

  database.setSetting("astrbot_receiver_qq", "111111, 222222");
  assert.equal(notifier.configured(), true);
  database.close();
});

test("a message is delivered to every configured receiver in order", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const database = new MonitorDatabase(":memory:");
  database.updateSettings({
    astrbotBaseUrl: "http://127.0.0.1:6185",
    astrbotApiKey: "abk_test",
    astrbotBotId: "napcat-qq",
    astrbotReceiverQq: "123456, 654321，123456"
  });
  const bodies = [];
  const notifier = new AstrBotNotifier(database, {
    fetchImpl: async (url, options) => {
      bodies.push(JSON.parse(options.body));
      return {
        ok: true,
        status: 200,
        async json() {
          return { status: "ok" };
        }
      };
    }
  });

  const sending = notifier.sendMessage("测试消息");
  // 第一条立即发送，第二条要等 4 秒节流窗口；用假定时器推进。
  for (let index = 0; index < 10 && bodies.length < 2; index += 1) {
    t.mock.timers.tick(5_000);
    await setImmediate();
  }
  assert.equal(bodies.length, 2, "expected both receivers to get the message");
  await sending;

  assert.deepEqual(bodies.map((body) => body.umo), [
    "napcat-qq:FriendMessage:123456",
    "napcat-qq:FriendMessage:654321"
  ]);
  assert.ok(bodies.every((body) => body.message === "测试消息"));
  database.close();
});

test("a partially failed alert only retries the receivers that failed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const database = new MonitorDatabase(":memory:");
  database.updateSettings({
    astrbotBaseUrl: "http://127.0.0.1:6185",
    astrbotApiKey: "abk_test",
    astrbotBotId: "napcat-qq",
    astrbotReceiverQq: "111111, 222222"
  });
  const rule = database.createRule({
    name: "GPU",
    category: "gpu",
    keyword: "GPU",
    priceCeilingCny: 1000,
    enabled: true
  });
  database.recordCandidateListing(
    rule,
    { itemId: "retry-gpu", title: "GPU", url: "https://www.goofish.com/item?id=retry-gpu", sellerName: "卖家" },
    500,
    true,
    "闲鱼低价提醒：GPU"
  );

  let failSecond = true;
  const umos = [];
  const notifier = new AstrBotNotifier(database, {
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      umos.push(body.umo);
      if (failSecond && body.umo.endsWith(":222222")) {
        return {
          ok: false,
          status: 500,
          async json() {
            return { status: "error", message: "发送失败" };
          }
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return { status: "ok" };
        }
      };
    }
  });

  const first = notifier.processOne();
  for (let index = 0; index < 10 && umos.length < 2; index += 1) {
    t.mock.timers.tick(5_000);
    await setImmediate();
  }
  assert.equal(await first, false);
  assert.deepEqual(umos, [
    "napcat-qq:FriendMessage:111111",
    "napcat-qq:FriendMessage:222222"
  ]);
  const afterFailure = database.db
    .prepare("SELECT status, attempts, delivered_to FROM notifications")
    .get();
  assert.equal(afterFailure.status, "pending");
  assert.equal(afterFailure.attempts, 1);
  assert.deepEqual(JSON.parse(afterFailure.delivered_to), ["111111"]);

  failSecond = false;
  t.mock.timers.tick(21_000);
  const second = notifier.processOne();
  for (let index = 0; index < 10 && umos.length < 3; index += 1) {
    t.mock.timers.tick(5_000);
    await setImmediate();
  }
  assert.equal(await second, true);
  assert.deepEqual(umos, [
    "napcat-qq:FriendMessage:111111",
    "napcat-qq:FriendMessage:222222",
    "napcat-qq:FriendMessage:222222"
  ]);
  const afterRetry = database.db
    .prepare("SELECT status, delivered_to FROM notifications")
    .get();
  assert.equal(afterRetry.status, "sent");
  assert.deepEqual(JSON.parse(afterRetry.delivered_to).sort(), ["111111", "222222"]);
  database.close();
});
