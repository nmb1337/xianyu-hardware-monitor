import test from "node:test";
import assert from "node:assert/strict";
import { completeAi } from "../src/ai-client.js";

function makeDatabase(key = "fixture-api-key") {
  const settings = {
    ai_base_url: "https://relay.example/v1",
    ai_model: "fixture-model",
    ai_api_key: key
  };
  return { getSetting: (name) => settings[name] };
}

const messages = [{ role: "user", content: 'Return JSON: {"ok":true}' }];
const success = () => Response.json({ choices: [{ message: { content: '{"ok":true}' } }] });

test("AI requests omit temperature and preserve provider, model, token limit and JSON mode", async () => {
  let calls = 0;
  const result = await completeAi(makeDatabase(), messages, {
    jsonMode: true,
    maxTokens: 900,
    fetchImpl: async (url, options) => {
      calls += 1;
      assert.equal(url, "https://relay.example/v1/chat/completions");
      assert.equal(options.redirect, "error");
      assert.equal(options.headers.authorization, "Bearer fixture-api-key");
      assert.deepEqual(JSON.parse(options.body), {
        model: "fixture-model", messages, max_tokens: 900, response_format: { type: "json_object" }
      });
      return success();
    }
  });
  assert.equal(result, '{"ok":true}');
  assert.equal(calls, 1);
});

test("AI retries an explicitly unsupported JSON format only once", async () => {
  const bodies = [];
  const result = await completeAi(makeDatabase(), messages, {
    jsonMode: true,
    fetchImpl: async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return bodies.length === 1
        ? Response.json({ error: { message: "Not supported", param: "response_format" } }, { status: 400 })
        : success();
    }
  });
  assert.equal(result, '{"ok":true}');
  assert.equal(bodies.length, 2);
  assert.equal("response_format" in bodies[1], false);
  assert.equal("temperature" in bodies[1], false);
  assert.equal(bodies[1].max_tokens, 1500);
});

for (const status of [400, 401, 403, 404, 422, 429, 503]) {
  test(`AI reports actionable upstream errors without unrelated retries: ${status}`, async () => {
    let calls = 0;
    await assert.rejects(completeAi(makeDatabase(), messages, {
      jsonMode: true,
      fetchImpl: async () => {
        calls += 1;
        return Response.json({
          error: { message: "Model unavailable", code: "model_not_found", param: "model" }
        }, { status });
      }
    }), new RegExp(`AI 请求失败 \\(${status}\\).*Model unavailable.*model_not_found.*param=model`));
    assert.equal(calls, 1);
  });
}

test("AI redacts literal and encoded credentials before shortening upstream errors", async () => {
  const key = 'fixture/secret+"quoted"';
  await assert.rejects(completeAi(makeDatabase(key), messages, {
    fetchImpl: async () => Response.json({
      error: {
        message: `Rejected\n${key} ${encodeURIComponent(key)} ${JSON.stringify(key).slice(1, -1)} Bearer other-secret sk-another-secret ${"x".repeat(1000)}`,
        code: key,
        param: key
      }
    }, { status: 400 })
  }), (error) => {
    assert.match(error.message, /Rejected.*REDACTED/);
    assert.doesNotMatch(error.message, /fixture|secret|quoted|[\r\n]/);
    assert.ok(error.message.length < 530);
    return true;
  });
});

test("AI reports the final error if the single JSON-mode retry also fails", async () => {
  let calls = 0;
  await assert.rejects(completeAi(makeDatabase(), messages, {
    jsonMode: true,
    fetchImpl: async () => {
      calls += 1;
      return Response.json({ error: { message: calls === 1
        ? "Unsupported response_format"
        : "Bad model fixture-api-key" } }, { status: 400 });
    }
  }), /Bad model \[REDACTED\]/);
  assert.equal(calls, 2);
});

test("AI does not display non-JSON upstream error pages", async () => {
  await assert.rejects(completeAi(makeDatabase(), messages, {
    fetchImpl: async () => new Response("<html>fixture-api-key</html>", { status: 502 })
  }), { message: "AI 请求失败 (502)" });
});

test("AI keeps local keyless endpoints and text-part responses working", async () => {
  assert.equal(await completeAi(makeDatabase(""), messages, {
    fetchImpl: async (_url, options) => {
      assert.equal("authorization" in options.headers, false);
      return Response.json({ choices: [{ message: { content: [{ type: "text", text: '{"ok":true}' }] } }] });
    }
  }), '{"ok":true}');
});

test("AI timeout also bounds the compatibility retry", async () => {
  let calls = 0;
  await assert.rejects(completeAi(makeDatabase(), messages, {
    jsonMode: true,
    timeoutMs: 30,
    fetchImpl: async (_url, options) => {
      calls += 1;
      if (calls === 1) {
        return Response.json({ error: { message: "Unsupported response_format" } }, { status: 400 });
      }
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
    }
  }), { message: "AI 请求超时" });
  assert.equal(calls, 2);
});

test("AI requests have no application deadline unless one is explicitly supplied", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finish;
  let signal;
  const pending = completeAi(makeDatabase(), messages, {
    fetchImpl: (_url, options) => {
      signal = options.signal;
      return new Promise((resolve) => { finish = resolve; });
    }
  });
  t.mock.timers.tick(3_600_000);
  assert.equal(signal.aborted, false);
  finish(success());
  assert.equal(await pending, '{"ok":true}');
});

test("AI can be cancelled during an indefinitely pending request", async () => {
  const controller = new AbortController();
  const pending = completeAi(makeDatabase(), messages, {
    signal: controller.signal,
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    })
  });
  controller.abort();
  await assert.rejects(pending, { message: "AI 请求已取消" });
});

test("AI rejects pre-cancelled requests without calling the relay", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(completeAi(makeDatabase(), messages, {
    signal: controller.signal,
    fetchImpl: async () => { assert.fail("A cancelled request must not be sent"); }
  }), { message: "AI 请求已取消" });
});

test("AI cancellation stops JSON-mode retries and discards late responses", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(completeAi(makeDatabase(), messages, {
    signal: controller.signal,
    jsonMode: true,
    fetchImpl: async () => {
      calls += 1;
      controller.abort();
      return Response.json({ error: { message: "Unsupported response_format" } }, { status: 400 });
    }
  }), { message: "AI 请求已取消" });
  assert.equal(calls, 1);
});
