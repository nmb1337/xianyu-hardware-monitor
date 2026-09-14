import test from "node:test";
import assert from "node:assert/strict";
import { AiReviewer, hasRiskEvidence, normalizeAiBaseUrl } from "../src/ai.js";
import { MonitorDatabase } from "../src/db.js";

function makeDatabase() {
  return new MonitorDatabase(":memory:");
}

const rule = {
  name: "4070",
  category: "gpu",
  keyword: "4070 显卡",
  includeTerms: ["4070"],
  excludeTerms: ["坏"],
  minPriceCny: null,
  maxPriceCny: 3000
};

const candidates = [{
  itemId: "new-1",
  title: "RTX 4070 显卡",
  price: 2100,
  sellerName: "卖家",
  url: "https://www.goofish.com/item?id=new-1"
}];

test("AI base URL accepts an OpenAI compatible root or endpoint", () => {
  assert.equal(normalizeAiBaseUrl("http://127.0.0.1:11434/v1/"), "http://127.0.0.1:11434/v1");
  assert.equal(normalizeAiBaseUrl("http://127.0.0.1:11434/v1/chat/completions"), "http://127.0.0.1:11434/v1");
  assert.throws(() => normalizeAiBaseUrl("127.0.0.1:11434/v1"), /有效/);
});

test("AI reviewer parses JSON decisions and sends only structured listing data", async () => {
  const database = makeDatabase();
  database.updateSettings({
    aiEnabled: true,
    aiBaseUrl: "http://127.0.0.1:11434/v1",
    aiModel: "fixture-model"
  });
  let request;
  const reviewer = new AiReviewer(database, {
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return {
        ok: true,
        status: 200,
        async json() {
          return { choices: [{ message: { content: '{"items":[{"itemId":"new-1","notify":false,"reason":"疑似配件"}]}' } }] };
        }
      };
    }
  });
  const result = await reviewer.reviewCandidates(rule, candidates);
  assert.equal(request.url, "http://127.0.0.1:11434/v1/chat/completions");
  assert.equal(request.body.model, "fixture-model");
  assert.match(request.body.messages[1].content, /new-1/);
  assert.doesNotMatch(request.body.messages[1].content, /apiKey|authorization/);
  assert.deepEqual(result.decisions.get("new-1"), {
    notify: false, block: false, risk: "none", confidence: 0, evidence: "", reason: "疑似配件"
  });
  assert.equal(result.error, null);
  database.close();
});

test("AI failures fail open and do not stop the monitor", async () => {
  const database = makeDatabase();
  database.updateSettings({ aiEnabled: true, aiBaseUrl: "http://127.0.0.1:11434/v1", aiModel: "fixture-model" });
  const reviewer = new AiReviewer(database, {
    fetchImpl: async () => ({ ok: false, status: 503, async json() { return {}; } })
  });
  const result = await reviewer.reviewCandidates(rule, candidates);
  assert.equal(result.decisions.size, 0);
  assert.match(result.error, /503/);
  database.close();
});

test("AI reviewer retries without response_format for compatible endpoints", async () => {
  const database = makeDatabase();
  database.updateSettings({ aiEnabled: true, aiBaseUrl: "http://127.0.0.1:11434/v1", aiModel: "fixture-model" });
  const bodies = [];
  const reviewer = new AiReviewer(database, {
    fetchImpl: async (url, options) => {
      bodies.push(JSON.parse(options.body));
      if (bodies.length === 1) {
        return { ok: false, status: 400, async json() { return {}; } };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return { choices: [{ message: { content: '{"items":[]}' } }] };
        }
      };
    }
  });
  const result = await reviewer.reviewCandidates(rule, candidates);
  assert.equal(result.error, null);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].response_format.type, "json_object");
  assert.equal("response_format" in bodies[1], false);
  database.close();
});

test("AI rejection retains a detailed reason but only displays evidence found in the listing", async (t) => {
  const database = makeDatabase();
  t.after(() => database.close());
  database.updateSettings({ aiEnabled: true, aiBaseUrl: "http://127.0.0.1:11434/v1", aiModel: "fixture-model" });
  const reason = "The listing describes an accessory rather than a complete graphics card. ".repeat(3);
  const reviewer = new AiReviewer(database, {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ items: [
          { itemId: "new-1", notify: false, reason, evidence: "not present in title" },
          { itemId: "box", notify: false, reason: "Only the box is included", evidence: "box only" }
        ] }) } }]
      })
    })
  });
  const result = await reviewer.reviewCandidates(rule, [...candidates, {
    itemId: "box", title: "GPU box only", price: 30
  }]);
  assert.equal(result.decisions.get("new-1").reason, reason.trim());
  assert.equal(result.decisions.get("new-1").evidence, "");
  assert.equal(result.decisions.get("box").evidence, "box only");
});

test("AI reviewer cancels all pending reviews, ignores late decisions, and can be reused", async (t) => {
  const database = makeDatabase();
  t.after(() => database.close());
  database.updateSettings({ aiEnabled: true, aiBaseUrl: "https://relay.example/v1", aiModel: "fixture-model" });
  const completions = [];
  const reviewer = new AiReviewer(database, {
    fetchImpl: () => new Promise((resolve) => { completions.push(resolve); }),
    timeoutMs: 0
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const first = reviewer.reviewCandidates(rule, candidates);
  const second = reviewer.reviewCandidates(rule, candidates);
  t.mock.timers.tick(3_600_000);
  assert.equal([...reviewer.pendingRequests].some((controller) => controller.signal.aborted), false);
  assert.equal(reviewer.pendingRequests.size, 2);
  reviewer.cancelPending();
  const response = () => Response.json({ choices: [{ message: { content: JSON.stringify({
    items: [{ itemId: "new-1", notify: false, reason: "Late result" }]
  }) } }] });
  completions.forEach((finish) => finish(response()));
  for (const result of await Promise.all([first, second])) {
    assert.equal(result.decisions.size, 0);
    assert.equal(result.cancelled, true);
    assert.equal(result.error, "AI 请求已取消");
  }
  assert.equal(reviewer.pendingRequests.size, 0);
  reviewer.options.fetchImpl = async () => response();
  const next = await reviewer.reviewCandidates(rule, candidates);
  assert.equal(next.error, null);
  assert.equal(next.decisions.size, 1);
  assert.equal(reviewer.pendingRequests.size, 0);
});

test("AI reviews are split into batches with sized output limits", async (t) => {
  const database = makeDatabase();
  t.after(() => database.close());
  database.updateSettings({ aiEnabled: true, aiBaseUrl: "http://127.0.0.1:11434/v1", aiModel: "fixture-model" });
  const batchItems = Array.from({ length: 5 }, (_, index) => ({
    itemId: `batch-${index}`,
    title: `RTX 4070 显卡 ${index}`,
    price: 2000,
    sellerName: "卖家",
    url: `https://www.goofish.com/item?id=batch-${index}`
  }));
  const batches = [];
  const limits = [];
  const reviewer = new AiReviewer(database, {
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      limits.push(body.max_tokens);
      const { candidates: batch } = JSON.parse(body.messages[1].content);
      batches.push(batch.map((item) => item.itemId));
      return Response.json({ choices: [{ message: { content: JSON.stringify({
        items: batch.map((item) => ({ itemId: item.itemId, notify: false, reason: "疑似配件" }))
      }) } }] });
    }
  });
  reviewer.batchSize = 2;
  const result = await reviewer.reviewCandidates(rule, batchItems);
  assert.deepEqual(batches, [["batch-0", "batch-1"], ["batch-2", "batch-3"], ["batch-4"]]);
  assert.equal(limits[0], 920);
  assert.equal(result.error, null);
  assert.equal(result.decisions.size, 5);
  for (const item of batchItems) {
    assert.equal(result.decisions.get(item.itemId).notify, false);
  }
});

test("one failed AI batch keeps the other batch decisions", async (t) => {
  const database = makeDatabase();
  t.after(() => database.close());
  database.updateSettings({ aiEnabled: true, aiBaseUrl: "https://relay.example/v1", aiModel: "fixture-model" });
  const batchItems = ["ok-1", "broken", "ok-2"].map((id) => ({
    itemId: id, title: `RTX 4070 显卡 ${id}`, price: 2000, url: `https://www.goofish.com/item?id=${id}`
  }));
  const reviewer = new AiReviewer(database, {
    fetchImpl: async (_url, options) => {
      const { candidates: batch } = JSON.parse(JSON.parse(options.body).messages[1].content);
      if (batch[0].itemId === "broken") {
        return new Response("relay down", { status: 502 });
      }
      return Response.json({ choices: [{ message: { content: JSON.stringify({
        items: batch.map((item) => ({ itemId: item.itemId, notify: false, reason: "疑似配件" }))
      }) } }] });
    }
  });
  reviewer.batchSize = 1;
  const result = await reviewer.reviewCandidates(rule, batchItems);
  assert.match(result.error, /502/);
  assert.equal(result.decisions.size, 2);
  assert.equal(result.decisions.has("broken"), false);
  assert.equal(result.cancelled, undefined);
});

test("a hung AI request times out instead of stalling the scan loop", async (t) => {
  const database = makeDatabase();
  t.after(() => database.close());
  database.updateSettings({ aiEnabled: true, aiBaseUrl: "https://relay.example/v1", aiModel: "fixture-model" });
  const reviewer = new AiReviewer(database, {
    timeoutMs: 20,
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason ?? new Error("aborted")), { once: true });
    })
  });
  const result = await reviewer.reviewCandidates(rule, candidates);
  assert.equal(result.error, "AI 请求超时");
  assert.equal(result.decisions.size, 0);
  assert.equal(reviewer.pendingRequests.size, 0);
});

test("AI blocking needs live title evidence and a 0-1 confidence", async (t) => {
  const database = makeDatabase();
  t.after(() => database.close());
  database.updateSettings({ aiEnabled: true, aiBaseUrl: "http://127.0.0.1:11434/v1", aiModel: "fixture-model" });
  const risky = [
    { itemId: "faulty", title: "GTX 1060 点不亮显卡", price: 200, url: "https://www.goofish.com/item?id=faulty" },
    { itemId: "clean", title: "无拆修 RTX 3060 显卡", price: 900, url: "https://www.goofish.com/item?id=clean" }
  ];
  assert.equal(hasRiskEvidence("GTX 1060 点不亮显卡", "点不亮"), true);
  assert.equal(hasRiskEvidence("无拆修 RTX 3060 显卡", "无拆修"), false);
  const reviewer = new AiReviewer(database, {
    fetchImpl: async () => Response.json({ choices: [{ message: { content: JSON.stringify({ items: [
      { itemId: "faulty", notify: false, block: true, risk: "faulty", confidence: "0.95", evidence: "点不亮", reason: "标题写明点不亮" },
      { itemId: "clean", notify: false, block: true, risk: "faulty", confidence: 0.99, evidence: "无拆修", reason: "提到了拆修" }
    ] }) } }] })
  });
  const result = await reviewer.reviewCandidates(rule, risky);
  const faulty = result.decisions.get("faulty");
  assert.equal(faulty.block, true);
  assert.equal(faulty.confidence, 0.95);
  assert.equal(faulty.evidence, "点不亮");
  const clean = result.decisions.get("clean");
  assert.equal(clean.notify, false);
  assert.equal(clean.block, false);
  assert.equal(clean.evidence, "无拆修");
});

test("AI responses wrapped in extra prose are still parsed", async (t) => {
  const database = makeDatabase();
  t.after(() => database.close());
  database.updateSettings({ aiEnabled: true, aiBaseUrl: "http://127.0.0.1:11434/v1", aiModel: "fixture-model" });
  const reviewer = new AiReviewer(database, {
    fetchImpl: async () => Response.json({ choices: [{ message: { content:
      '好的，以下是审核结果：\n{"items":[{"itemId":"new-1","notify":false,"reason":"疑似配件"}]}\n希望有帮助。' } }] })
  });
  const result = await reviewer.reviewCandidates(rule, candidates);
  assert.equal(result.error, null);
  assert.equal(result.decisions.get("new-1").notify, false);
});
