import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MINIMUM_RULE_INTERVAL_SECONDS } from "./pacing.js";

function now() {
  return Date.now();
}

function parseJson(value, fallback = []) {
  try {
    const result = JSON.parse(value ?? "");
    return Array.isArray(result) ? result : fallback;
  } catch {
    return fallback;
  }
}

function toBoolean(value) {
  return Boolean(value);
}

function serializeTerms(value) {
  return JSON.stringify(Array.isArray(value) ? value : []);
}

function toRule(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    name: row.name,
    category: row.category,
    keyword: row.keyword,
    includeTerms: parseJson(row.include_terms),
    excludeTerms: parseJson(row.exclude_terms),
    minPriceCny: row.min_price_cny,
    maxPriceCny: row.price_ceiling_cny,
    priceCeilingCny: row.price_ceiling_cny,
    personalOnly: toBoolean(row.personal_only),
    enabled: toBoolean(row.enabled),
    scanIntervalSeconds: Math.max(row.scan_interval_seconds, MINIMUM_RULE_INTERVAL_SECONDS),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastScannedAt: row.last_scanned_at,
    nextScanAt: row.next_scan_at,
    lastError: row.last_error
  };
}

export class MonitorDatabase {
  constructor(databasePath) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.#migrate();
    this.recoverSendingNotifications();
  }

  #migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        keyword TEXT NOT NULL,
        include_terms TEXT NOT NULL DEFAULT '[]',
        exclude_terms TEXT NOT NULL DEFAULT '[]',
        price_ceiling_cny REAL NOT NULL,
        personal_only INTEGER NOT NULL DEFAULT 1,
        enabled INTEGER NOT NULL DEFAULT 1,
        scan_interval_seconds INTEGER NOT NULL DEFAULT 300,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_scanned_at INTEGER,
        next_scan_at INTEGER,
        last_error TEXT
      );

      CREATE TABLE IF NOT EXISTS listings (
        rule_id INTEGER NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL,
        title TEXT NOT NULL,
        current_price REAL NOT NULL,
        url TEXT NOT NULL,
        seller_name TEXT,
        is_personal INTEGER,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        below_threshold_alerted INTEGER NOT NULL DEFAULT 0,
        last_alert_price REAL,
        PRIMARY KEY (rule_id, item_id)
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id INTEGER NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        sent_at INTEGER,
        available_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS blocked_listings (
        item_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        seller_name TEXT,
        block_reason TEXT NOT NULL DEFAULT '',
        blocked_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS search_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id INTEGER,
        started_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_rules_due
        ON rules(enabled, next_scan_at);
      CREATE INDEX IF NOT EXISTS idx_listings_seen
        ON listings(last_seen_at DESC);
      CREATE INDEX IF NOT EXISTS idx_notifications_queue
        ON notifications(status, available_at);
      CREATE INDEX IF NOT EXISTS idx_blocked_listings_time
        ON blocked_listings(blocked_at DESC);
      CREATE INDEX IF NOT EXISTS idx_search_attempts_time ON search_attempts(started_at);
    `);

    const columns = this.db.prepare("PRAGMA table_info(rules)").all();
    if (!columns.some((column) => column.name === "min_price_cny")) {
      this.db.exec("ALTER TABLE rules ADD COLUMN min_price_cny REAL");
    }

    const blockedColumns = this.db.prepare("PRAGMA table_info(blocked_listings)").all();
    if (!blockedColumns.some((column) => column.name === "block_reason")) {
      this.db.exec("ALTER TABLE blocked_listings ADD COLUMN block_reason TEXT NOT NULL DEFAULT ''");
    }

    if (this.getSetting("search_price_parser_version") !== "2") {
      this.db.exec(`
        DELETE FROM notifications;
        DELETE FROM listings;
        UPDATE rules
        SET last_scanned_at = NULL, next_scan_at = ${now()}, last_error = NULL;
      `);
      this.setSetting("search_price_parser_version", "2");
    }

    this.db
      .prepare(`
        UPDATE rules
        SET last_error = NULL, next_scan_at = ?
        WHERE last_error LIKE '%Target page, context or browser has been closed%'
      `)
      .run(now());

    this.db
      .prepare(`
        UPDATE rules
        SET scan_interval_seconds = ?
        WHERE scan_interval_seconds < ?
      `)
      .run(MINIMUM_RULE_INTERVAL_SECONDS, MINIMUM_RULE_INTERVAL_SECONDS);
  }

  close() {
    this.db.close();
  }

  initializeFromEnvironment(environment) {
    const initialValues = [
      ["astrbot_base_url", environment.ASTRBOT_BASE_URL],
      ["astrbot_api_key", environment.ASTRBOT_API_KEY],
      ["astrbot_bot_id", environment.ASTRBOT_BOT_ID],
      ["astrbot_receiver_qq", environment.ASTRBOT_RECEIVER_QQ],
      ["ai_base_url", environment.AI_BASE_URL],
      ["ai_api_key", environment.AI_API_KEY],
      ["ai_model", environment.AI_MODEL],
      ["ai_enabled", ["1", "true", "yes", "on"].includes(String(environment.AI_ENABLED ?? "").toLowerCase()) ? "1" : undefined]
    ];
    for (const [key, value] of initialValues) {
      if (!this.getSetting(key) && value) {
        this.setSetting(key, value);
      }
    }
  }

  getSetting(key) {
    return this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? null;
  }

  setSetting(key, value) {
    this.db
      .prepare(`
        INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `)
      .run(key, String(value), now());
  }

  getPublicSettings() {
    return {
      astrbotBaseUrl: this.getSetting("astrbot_base_url") ?? "http://127.0.0.1:6185",
      astrbotApiKeyConfigured: Boolean(this.getSetting("astrbot_api_key")),
      astrbotBotId: this.getSetting("astrbot_bot_id") ?? "",
      astrbotReceiverQq: this.getSetting("astrbot_receiver_qq") ?? "",
      aiEnabled: this.getSetting("ai_enabled") === "1",
      aiBaseUrl: this.getSetting("ai_base_url") ?? "http://127.0.0.1:11434/v1",
      aiApiKeyConfigured: Boolean(this.getSetting("ai_api_key")),
      aiModel: this.getSetting("ai_model") ?? "qwen2.5:7b"
    };
  }

  updateSettings({
    astrbotBaseUrl,
    astrbotApiKey,
    astrbotBotId,
    astrbotReceiverQq,
    aiEnabled,
    aiBaseUrl,
    aiApiKey,
    aiModel
  }) {
    if (typeof astrbotBaseUrl === "string" && astrbotBaseUrl.trim()) {
      this.setSetting("astrbot_base_url", astrbotBaseUrl.trim());
    }
    if (typeof astrbotApiKey === "string" && astrbotApiKey.trim()) {
      this.setSetting("astrbot_api_key", astrbotApiKey.trim());
    }
    if (typeof astrbotBotId === "string") {
      this.setSetting("astrbot_bot_id", astrbotBotId.trim());
    }
    if (typeof astrbotReceiverQq === "string") {
      this.setSetting("astrbot_receiver_qq", astrbotReceiverQq.trim());
    }
    if (typeof aiEnabled === "boolean") {
      this.setSetting("ai_enabled", aiEnabled ? "1" : "0");
    }
    if (typeof aiBaseUrl === "string" && aiBaseUrl.trim()) {
      this.setSetting("ai_base_url", aiBaseUrl.trim());
    }
    if (typeof aiApiKey === "string" && aiApiKey.trim()) {
      this.setSetting("ai_api_key", aiApiKey.trim());
    }
    if (typeof aiModel === "string" && aiModel.trim()) {
      this.setSetting("ai_model", aiModel.trim());
    }
    return this.getPublicSettings();
  }

  listRules() {
    return this.db
      .prepare("SELECT * FROM rules ORDER BY enabled DESC, updated_at DESC, id DESC")
      .all()
      .map(toRule);
  }

  getRule(id) {
    return toRule(this.db.prepare("SELECT * FROM rules WHERE id = ?").get(id));
  }

  createRule(input) {
    const timestamp = now();
    const maximum = input.maxPriceCny ?? input.priceCeilingCny;
    const result = this.db
      .prepare(`
        INSERT INTO rules (
          name, category, keyword, include_terms, exclude_terms, min_price_cny, price_ceiling_cny,
          personal_only, enabled, scan_interval_seconds, created_at, updated_at, next_scan_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.name,
        input.category,
        input.keyword,
        serializeTerms(input.includeTerms),
        serializeTerms(input.excludeTerms),
        input.minPriceCny ?? null,
        maximum,
        input.personalOnly ? 1 : 0,
        input.enabled ? 1 : 0,
        input.scanIntervalSeconds,
        timestamp,
        timestamp,
        timestamp
      );
    return this.getRule(Number(result.lastInsertRowid));
  }

  updateRule(id, input) {
    const current = this.getRule(id);
    if (!current) {
      return null;
    }

    const timestamp = now();
    const next = { ...current, ...input };
    const maximum = next.maxPriceCny ?? next.priceCeilingCny;
    this.db
      .prepare(`
        UPDATE rules SET
          name = ?, category = ?, keyword = ?, include_terms = ?, exclude_terms = ?,
          min_price_cny = ?, price_ceiling_cny = ?, personal_only = ?, enabled = ?, scan_interval_seconds = ?,
          updated_at = ?, last_scanned_at = NULL, next_scan_at = ?, last_error = NULL
        WHERE id = ?
      `)
      .run(
        next.name,
        next.category,
        next.keyword,
        serializeTerms(next.includeTerms),
        serializeTerms(next.excludeTerms),
        next.minPriceCny ?? null,
        maximum,
        next.personalOnly ? 1 : 0,
        next.enabled ? 1 : 0,
        next.scanIntervalSeconds,
        timestamp,
        next.enabled ? timestamp : null,
        id
      );
    this.db
      .prepare("DELETE FROM listings WHERE rule_id = ?")
      .run(id);
    this.db
      .prepare("DELETE FROM notifications WHERE rule_id = ?")
      .run(id);
    return this.getRule(id);
  }

  deleteRule(id) {
    return this.db.prepare("DELETE FROM rules WHERE id = ?").run(id).changes > 0;
  }

  dueRules(timestamp = now()) {
    return this.db
      .prepare(`
        SELECT * FROM rules
        WHERE enabled = 1 AND (next_scan_at IS NULL OR next_scan_at <= ?)
        ORDER BY COALESCE(next_scan_at, 0) ASC, id ASC
      `)
      .all(timestamp)
      .map(toRule);
  }

  recentSearchAttempts(since) {
    return this.db.prepare("SELECT started_at FROM search_attempts WHERE started_at > ? ORDER BY started_at")
      .all(since).map((row) => row.started_at);
  }

  reserveSearchAttempt(ruleId, timestamp, nextSearchAt) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO search_attempts(rule_id, started_at) VALUES (?, ?)").run(ruleId, timestamp);
      this.setSetting("xianyu_global_search_next_at", nextSearchAt);
      this.db.prepare("DELETE FROM search_attempts WHERE started_at < ?").run(timestamp - 7 * 24 * 60 * 60_000);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  postponeEnabledRules(fromTimestamp = now(), gapMs = 90_000, { reset = false } = {}) {
    const rows = this.db
      .prepare(`
        SELECT id, next_scan_at AS nextScanAt FROM rules
        WHERE enabled = 1
        ORDER BY COALESCE(next_scan_at, 0) ASC, id ASC
      `)
      .all();
    const statement = this.db.prepare(
      "UPDATE rules SET next_scan_at = ?, updated_at = ? WHERE id = ?"
    );
    const timestamp = now();
    rows.forEach((row, index) => {
      const scheduled = fromTimestamp + (index + 1) * gapMs;
      const nextScanAt = reset
        ? scheduled
        : Math.max(Number(row.nextScanAt) || 0, scheduled);
      statement.run(nextScanAt, timestamp, row.id);
    });
    return rows.length;
  }

  markRuleScanned(id, { nextScanAt, error = null }) {
    if (error) {
      this.db
        .prepare(`
          UPDATE rules
          SET next_scan_at = ?, last_error = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(nextScanAt, error, now(), id);
      return;
    }
    this.db
      .prepare(`
        UPDATE rules
        SET last_scanned_at = ?, next_scan_at = ?, last_error = NULL, updated_at = ?
        WHERE id = ?
      `)
      .run(now(), nextScanAt, now(), id);
  }

  recordCandidateListing(rule, listing, price, shouldAlert, message) {
    const existing = this.db
      .prepare("SELECT * FROM listings WHERE rule_id = ? AND item_id = ?")
      .get(rule.id, listing.itemId);
    if (this.isListingBlocked(listing.itemId)) {
      return { queued: false, existing: Boolean(existing), blocked: true };
    }

    const timestamp = now();
    let queued = false;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!existing) {
        this.db
          .prepare(`
            INSERT INTO listings (
              rule_id, item_id, title, current_price, url, seller_name, is_personal,
              first_seen_at, last_seen_at, below_threshold_alerted, last_alert_price
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            rule.id,
            listing.itemId,
            listing.title,
            price,
            listing.url,
            listing.sellerName ?? "",
            listing.isPersonal === false ? 0 : 1,
            timestamp,
            timestamp,
            shouldAlert ? 1 : 0,
            shouldAlert ? price : null
          );
        queued = shouldAlert;
      } else {
        this.db
          .prepare(`
            UPDATE listings
            SET title = ?, current_price = ?, url = ?, seller_name = ?, is_personal = ?,
                last_seen_at = ?
            WHERE rule_id = ? AND item_id = ?
          `)
          .run(
            listing.title,
            price,
            listing.url,
            listing.sellerName ?? "",
            listing.isPersonal === false ? 0 : 1,
            timestamp,
            rule.id,
            listing.itemId
          );
      }

      if (queued) {
        this.db
          .prepare(`
            INSERT INTO notifications (
              rule_id, item_id, title, message, status, attempts, created_at, available_at
            ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)
          `)
          .run(rule.id, listing.itemId, listing.title, message, timestamp, timestamp);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return { queued, existing: Boolean(existing), blocked: false };
  }

  listListings(limit = 100) {
    return this.db
      .prepare(`
        SELECT
          listings.rule_id AS ruleId, listings.item_id AS itemId, listings.title,
          listings.current_price AS currentPrice, listings.url, listings.seller_name AS sellerName,
          listings.is_personal AS isPersonal, listings.first_seen_at AS firstSeenAt,
          listings.last_seen_at AS lastSeenAt, listings.last_alert_price AS lastAlertPrice,
          rules.name AS ruleName, rules.category AS category,
          rules.min_price_cny AS minPriceCny, rules.price_ceiling_cny AS maxPriceCny
        FROM listings
        JOIN rules ON rules.id = listings.rule_id
        WHERE listings.below_threshold_alerted = 1
          AND NOT EXISTS (
            SELECT 1
            FROM blocked_listings
            WHERE blocked_listings.item_id = listings.item_id
          )
        ORDER BY listings.last_seen_at DESC
        LIMIT ?
      `)
      .all(Math.max(1, Math.min(500, Number(limit) || 100)))
      .map((row) => ({ ...row, isPersonal: Boolean(row.isPersonal) }));
  }

  listBlockedListings(limit = 100) {
    return this.db
      .prepare(`
        SELECT
          item_id AS itemId, title, url, seller_name AS sellerName,
          block_reason AS blockReason, blocked_at AS blockedAt
        FROM blocked_listings
        ORDER BY blocked_at DESC
        LIMIT ?
      `)
      .all(Math.max(1, Math.min(500, Number(limit) || 100)));
  }

  isListingBlocked(itemId) {
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM blocked_listings WHERE item_id = ?")
        .get(String(itemId))
    );
  }

  hasListing(ruleId, itemId) {
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM listings WHERE rule_id = ? AND item_id = ?")
        .get(Number(ruleId), String(itemId))
    );
  }

  blockListing(listing) {
    const itemId = String(listing.itemId ?? "").trim();
    const title = String(listing.title ?? "").trim();
    const url = String(listing.url ?? "").trim();
    if (!itemId || !title || !url) {
      throw new Error("屏蔽商品信息不完整");
    }
    const blockReason = String(listing.blockReason ?? "").trim().slice(0, 300);

    const timestamp = now();
    this.db
      .prepare(`
        INSERT INTO blocked_listings (item_id, title, url, seller_name, block_reason, blocked_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(item_id) DO UPDATE SET
          title = excluded.title,
          url = excluded.url,
          seller_name = excluded.seller_name,
          block_reason = excluded.block_reason,
          blocked_at = excluded.blocked_at
      `)
      .run(itemId, title, url, String(listing.sellerName ?? ""), blockReason, timestamp);
    this.db
      .prepare(`
        UPDATE notifications
        SET status = 'blocked', last_error = '商品已被屏蔽'
        WHERE item_id = ? AND status IN ('pending', 'sending')
      `)
      .run(itemId);
    return this.db
      .prepare(`
        SELECT
          item_id AS itemId, title, url, seller_name AS sellerName,
          block_reason AS blockReason, blocked_at AS blockedAt
        FROM blocked_listings
        WHERE item_id = ?
      `)
      .get(itemId);
  }

  unblockListing(itemId) {
    const deleted = this.db
      .prepare("DELETE FROM blocked_listings WHERE item_id = ?")
      .run(String(itemId)).changes > 0;
    if (!deleted) {
      return false;
    }
    this.db
      .prepare(`
        UPDATE notifications
        SET status = 'pending', available_at = ?, last_error = NULL
        WHERE item_id = ? AND status = 'blocked' AND last_error = '商品已被屏蔽'
      `)
      .run(now(), String(itemId));
    return true;
  }

  listNotifications(limit = 100) {
    return this.db
      .prepare(`
        SELECT
          notifications.id, notifications.rule_id AS ruleId, notifications.item_id AS itemId,
          notifications.title, notifications.status, notifications.attempts,
          notifications.last_error AS lastError, notifications.created_at AS createdAt,
          notifications.sent_at AS sentAt, rules.name AS ruleName
        FROM notifications
        JOIN rules ON rules.id = notifications.rule_id
        ORDER BY notifications.created_at DESC
        LIMIT ?
      `)
      .all(Math.max(1, Math.min(500, Number(limit) || 100)));
  }

  recoverSendingNotifications() {
    this.db
      .prepare(`
        UPDATE notifications
        SET status = 'pending', available_at = ?, last_error = '程序重启后恢复发送'
        WHERE status = 'sending'
      `)
      .run(now());
  }

  claimNextNotification(timestamp = now()) {
    const notification = this.db
      .prepare(`
        SELECT * FROM notifications
        WHERE status = 'pending' AND available_at <= ?
          AND NOT EXISTS (
            SELECT 1
            FROM blocked_listings
            WHERE blocked_listings.item_id = notifications.item_id
          )
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      `)
      .get(timestamp);

    if (!notification) {
      return null;
    }

    this.db
      .prepare("UPDATE notifications SET status = 'sending' WHERE id = ? AND status = 'pending'")
      .run(notification.id);
    return notification;
  }

  markNotificationSent(id) {
    this.db
      .prepare(`
        UPDATE notifications
        SET status = 'sent', sent_at = ?, last_error = NULL
        WHERE id = ?
      `)
      .run(now(), id);
  }

  markNotificationFailed(id, attempts, errorMessage) {
    const terminal = attempts >= 6;
    const delayMilliseconds = Math.min(20 * 60_000, 20_000 * 2 ** Math.max(0, attempts - 1));
    this.db
      .prepare(`
        UPDATE notifications
        SET status = ?, attempts = ?, last_error = ?, available_at = ?
        WHERE id = ?
      `)
      .run(
        terminal ? "failed" : "pending",
        attempts,
        String(errorMessage).slice(0, 500),
        now() + delayMilliseconds,
        id
      );
  }

  retryFailedNotifications() {
    return this.db
      .prepare(`
        UPDATE notifications
        SET status = 'pending', attempts = 0, last_error = NULL, available_at = ?
        WHERE status = 'failed'
      `)
      .run(now()).changes;
  }

}
