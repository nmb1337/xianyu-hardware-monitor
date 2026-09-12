import test from "node:test";
import assert from "node:assert/strict";
import { AiReviewer, normalizeAiBaseUrl } from "../src/ai.js";
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
  assert.deepEqual(result.decisions.get("new-1"), { notify: false, reason: "疑似配件" });
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
