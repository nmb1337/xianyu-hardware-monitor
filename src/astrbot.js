const MINIMUM_SEND_INTERVAL_MS = 4_000;

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function normalizeAstrBotBaseUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    throw new Error("AstrBot 地址不能为空");
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("AstrBot 地址必须是有效的 http:// 或 https:// 地址");
  }

  if (!["http:", "https:"].includes(url.protocol) || !url.host || url.username || url.password) {
    throw new Error("AstrBot 地址必须是有效的 http:// 或 https:// 地址");
  }

  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/api\/v1\/?$/, "").replace(/\/+$/, "") || "/";
  return url.toString().replace(/\/+$/, "");
}

export class AstrBotNotifier {
  constructor(database, { fetchImpl = globalThis.fetch } = {}) {
    this.database = database;
    this.fetch = fetchImpl;
    this.processing = false;
    this.lastSentAt = 0;
  }

  configured() {
    return Boolean(
      this.database.getSetting("astrbot_base_url")
      && this.database.getSetting("astrbot_api_key")
      && this.database.getSetting("astrbot_bot_id")
      && this.database.getSetting("astrbot_receiver_qq")
    );
  }

  async sendMessage(message) {
    const baseUrl = this.database.getSetting("astrbot_base_url");
    const apiKey = this.database.getSetting("astrbot_api_key");
    const botId = this.database.getSetting("astrbot_bot_id");
    const qq = this.database.getSetting("astrbot_receiver_qq");
    if (!baseUrl || !apiKey || !botId || !qq) {
      throw new Error("请先配置 AstrBot 地址、IM API Key、机器人 ID 和接收 QQ 号");
    }

    const waitTime = this.lastSentAt + MINIMUM_SEND_INTERVAL_MS - Date.now();
    if (waitTime > 0) {
      await wait(waitTime);
    }

    const response = await this.fetch(`${normalizeAstrBotBaseUrl(baseUrl)}/api/v1/im/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        umo: `${botId}:FriendMessage:${qq}`,
        message: String(message).slice(0, 1_500)
      })
    });
    this.lastSentAt = Date.now();

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`AstrBot 返回了无法识别的响应 (${response.status})`);
    }

    if (!response.ok || payload?.status !== "ok") {
      throw new Error(payload?.message || `AstrBot 请求失败 (${response.status})`);
    }

    return payload;
  }

  async processOne() {
    if (this.processing || !this.configured()) {
      return false;
    }

    const notification = this.database.claimNextNotification();
    if (!notification) {
      return false;
    }

    this.processing = true;
    try {
      await this.sendMessage(notification.message);
      this.database.markNotificationSent(notification.id);
      return true;
    } catch (error) {
      this.database.markNotificationFailed(
        notification.id,
        notification.attempts + 1,
        error instanceof Error ? error.message : "未知 AstrBot 错误"
      );
      return false;
    } finally {
      this.processing = false;
    }
  }
}
