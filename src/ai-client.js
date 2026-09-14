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

async function readAiError(response, key) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    return "";
  }
  const error = payload?.error;
  const message = typeof error === "string" ? error : error?.message ?? payload?.message;
  const fields = [
    typeof message === "string" ? message : "",
    typeof error?.code === "string" ? `code=${error.code}` : "",
    typeof error?.param === "string" ? `param=${error.param}` : ""
  ];
  let detail = fields.filter(Boolean).join("; ");
  if (key) {
    for (const secret of new Set([key, encodeURIComponent(key), JSON.stringify(key).slice(1, -1)])) {
      detail = detail.split(secret).join("[REDACTED]");
    }
  }
  return detail.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[\w-]+/gi, "[REDACTED]")
    .replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 500);
}

export async function completeAi(database, messages, {
  fetchImpl = globalThis.fetch, timeoutMs = 0, jsonMode = false, maxTokens = 1500, signal
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
  const cancel = () => controller.abort();
  if (signal?.aborted) {
    cancel();
  } else {
    signal?.addEventListener("abort", cancel, { once: true });
  }
  let timedOut = false;
  const timer = Number.isFinite(timeoutMs) && timeoutMs > 0 ? setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs) : null;
  // Some compatible models reject temperature; use the provider's sampling defaults.
  const body = { model, messages, max_tokens: maxTokens };
  const send = (json) => fetchImpl(`${baseUrl}/chat/completions`, {
    method: "POST", headers, signal: controller.signal, redirect: "error",
    body: JSON.stringify(json ? { ...body, response_format: { type: "json_object" } } : body)
  });
  try {
    controller.signal.throwIfAborted();
    let response = await send(jsonMode);
    let detail = response.ok ? "" : await readAiError(response, key);
    controller.signal.throwIfAborted();
    if (jsonMode && !response.ok && [400, 404, 422].includes(response.status)
      && (!detail || /response_format|json_object|json.?mode|structured.?outputs?/i.test(detail))) {
      response = await send(false);
      detail = response.ok ? "" : await readAiError(response, key);
      controller.signal.throwIfAborted();
    }
    if (!response.ok) {
      throw new Error(`AI 请求失败 (${response.status})${detail ? `：${detail}` : ""}`);
    }
    const payload = await response.json();
    controller.signal.throwIfAborted();
    const content = payload?.choices?.[0]?.message?.content;
    const text = typeof content === "string" ? content
      : Array.isArray(content) ? content.map((part) => typeof part === "string" ? part : part?.text ?? "").join("") : "";
    if (!text.trim() || text.length > 100_000) {
      throw new Error("AI 返回内容为空或过长");
    }
    return text;
  } catch (error) {
    if (signal?.aborted) {
      throw new Error("AI 请求已取消");
    }
    if (timedOut) {
      throw new Error("AI 请求超时");
    }
    if (error instanceof Error && /^AI /.test(error.message)) {
      throw error;
    }
    throw new Error("AI 连接失败，请检查接口地址、密钥和网络");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}
