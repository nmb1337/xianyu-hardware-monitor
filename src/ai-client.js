export function normalizeAiBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? "").trim());
  } catch {
    throw new Error("AI 地址必须是有效的 http:// 或 https:// 地址");
  }
  if (!["http:", "https:"].includes(url.protocol) || !url.host || url.username || url.password) {
    throw new Error("AI 地址必须是有效的 http:// 或 https:// 地址");
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/chat\/completions\/?$/i, "").replace(/\/+$/, "") || "/";
  return url.toString().replace(/\/+$/, "");
}

export async function completeAi(database, messages, {
  fetchImpl = globalThis.fetch, timeoutMs = 20_000, jsonMode = false, maxTokens = 1500
} = {}) {
  const baseUrl = normalizeAiBaseUrl(database.getSetting("ai_base_url"));
  const model = database.getSetting("ai_model");
  if (!model) {
    throw new Error("请先保存 AI 模型名称");
  }
  const key = database.getSetting("ai_api_key");
  const headers = { "content-type": "application/json" };
  if (key) {
    headers.authorization = `Bearer ${key}`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const body = { model, messages, temperature: 0.1, max_tokens: maxTokens };
  const send = (json) => fetchImpl(`${baseUrl}/chat/completions`, {
    method: "POST", headers, signal: controller.signal, redirect: "error",
    body: JSON.stringify(json ? { ...body, response_format: { type: "json_object" } } : body)
  });
  try {
    let response = await send(jsonMode);
    if (jsonMode && !response.ok && [400, 404, 422].includes(response.status)) {
      await response.body?.cancel();
      response = await send(false);
    }
    if (!response.ok) {
      throw new Error(`AI 请求失败 (${response.status})`);
    }
    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    const text = typeof content === "string" ? content
      : Array.isArray(content) ? content.map((part) => typeof part === "string" ? part : part?.text ?? "").join("") : "";
    if (!text.trim() || text.length > 100_000) {
      throw new Error("AI 返回内容为空或过长");
    }
    return text;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("AI 请求超时");
    }
    if (error instanceof Error && /^AI /.test(error.message)) {
      throw error;
    }
    throw new Error("AI 连接失败，请检查接口地址、密钥和网络");
  } finally {
    clearTimeout(timer);
  }
}
