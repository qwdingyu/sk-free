// ═══════════════════════════════════════════════════════════════════════════════
// deadurls.js — 死链接黑名单管理（D1 版本）
// 从 KV 全量 JSON 重写迁移到 D1 单行操作
// ═══════════════════════════════════════════════════════════════════════════════

import { dbAll, dbRun } from "./db.js";

/**
 * 获取死链接列表（返回以 URL 为 key 的对象）
 * @param {object} db — D1 数据库实例
 * @returns {Promise<object>} { "https://example.com": { addedAt, status, reason, error }, ... }
 */
export async function getDeadUrls(db) {
  const rows = await dbAll(db, "SELECT url, added_at, status, reason, error FROM dead_urls");
  const deadUrls = {};
  for (const row of rows) {
    deadUrls[row.url] = {
      addedAt: row.added_at,
      status: row.status,
      reason: row.reason,
      error: row.error,
    };
  }
  return deadUrls;
}

/**
 * 添加死链接
 * @param {object} db — D1 数据库实例
 * @param {string} url — 死链接 URL
 * @param {object} info — 附加信息 { reason?, error? }
 */
export async function addDeadUrl(db, url, info = {}) {
  await dbRun(
    db,
    "INSERT OR REPLACE INTO dead_urls (url, added_at, status, reason, error) VALUES (?, ?, 0, ?, ?)",
    [url, Date.now(), info.reason || "unreachable", info.error || ""]
  );
}

/**
 * 移除死链接
 * @param {object} db — D1 数据库实例
 * @param {string} url — 要移除的 URL
 * @returns {Promise<number>} 影响行数
 */
export async function removeDeadUrl(db, url) {
  const result = await dbRun(db, "DELETE FROM dead_urls WHERE url = ?", [url]);
  return result.meta?.changes || 0;
}

/**
 * 批量操作死链接（添加或移除）
 * @param {object} db — D1 数据库实例
 * @param {string[]} urls — URL 数组
 * @param {string} action — "add" 或 "remove"
 * @returns {{ changed: number }} 变更数量
 */
export async function batchDeadUrls(db, urls, action = "remove") {
  let changed = 0;
  if (action === "add") {
    for (const url of urls) {
      const result = await dbRun(
        db,
        "INSERT OR IGNORE INTO dead_urls (url, added_at, status, reason) VALUES (?, ?, 0, 'auto-detected')",
        [url, Date.now()]
      );
      if (result.meta?.changes > 0) changed++;
    }
  } else {
    for (const url of urls) {
      const result = await dbRun(db, "DELETE FROM dead_urls WHERE url = ?", [url]);
      if (result.meta?.changes > 0) changed++;
    }
  }
  return { changed };
}
