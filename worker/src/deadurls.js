// ═══════════════════════════════════════════════════════════════════════════════
// deadurls.js — 死链接黑名单管理（D1 版本）
// 从 KV 全量 JSON 重写迁移到 D1 单行操作
// ═══════════════════════════════════════════════════════════════════════════════

import { dbAll, dbRun, dbBatch } from "./db.js";

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
 * 添加死链接记录
 * 注意：不再自动禁用站点（概率性探测不应驱动不可逆动作）
 * 站点启用状态由管理员手动管理，或由连续多次检测失败后确认
 *
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
 * 移除死链接（自动恢复匹配站点启用状态）
 * @param {object} db — D1 数据库实例
 * @param {string} url — 要移除的 URL
 * @returns {Promise<number>} 影响行数
 */
export async function removeDeadUrl(db, url) {
  // batch：删黑名单 + 恢复站点状态是一组语义。分两次往返既多耗一个 subrequest，
  // 也可能只成功一半（黑名单删了但站点还停用着）。
  const results = await dbBatch(db, [
    db.prepare("DELETE FROM dead_urls WHERE url = ?").bind(url),
    // 联动：恢复 URL 匹配站点的启用状态（死链接移除说明站点已恢复）
    db
      .prepare("UPDATE sites SET enabled = 1, updated_at = datetime('now') WHERE url = ? AND enabled = 0")
      .bind(url),
  ]);
  return results?.[0]?.meta?.changes || 0;
}

/**
 * 批量操作死链接（添加或移除）
 * 移除语义与单条 removeDeadUrl 一致：从黑名单删除的同时恢复 URL 匹配站点的
 * 启用状态（死链接移除说明站点已恢复）。UI 文案"相关站点将自动恢复启用状态"
 * 承诺的就是这个行为，此前批量只 DELETE 不联动，与文案矛盾。
 * 添加路径不动站点（概率性探测不应驱动不可逆动作）。
 *
 * @param {object} db — D1 数据库实例
 * @param {string[]} urls — URL 数组
 * @param {string} action — "add" 或 "remove"
 * @returns {Promise<{ changed: number }>} 变更数量
 */
export async function batchDeadUrls(db, urls, action = "remove") {
  if (!Array.isArray(urls) || urls.length === 0) return { changed: 0 };

  // 原来逐条 await dbRun：N 个 URL = N 次串行 D1 往返，而 **D1 查询计入
  // Workers 的 50 subrequest 配额**，URL 一多就先报 1101 而不是慢慢跑完。
  // 改成单次 batch：1 个 subrequest，且原子。
  const now = Date.now();
  const statements =
    action === "add"
      ? urls.map((url) =>
          db
            .prepare(
              "INSERT OR IGNORE INTO dead_urls (url, added_at, status, reason) VALUES (?, ?, 0, 'auto-detected')"
            )
            .bind(url, now)
        )
      // remove：DELETE + 恢复站点，两条一组（batch 内原子）
      : urls.flatMap((url) => [
          db.prepare("DELETE FROM dead_urls WHERE url = ?").bind(url),
          db
            .prepare("UPDATE sites SET enabled = 1, updated_at = datetime('now') WHERE url = ? AND enabled = 0")
            .bind(url),
        ]);

  const results = await dbBatch(db, statements);
  // 只统计 DELETE（偶数位）的影响行数为"移除的死链数"：
  // UPDATE 恢复站点行数不算在内，避免前端"已移除 N 个死链接"虚高。
  const changed = (results || []).reduce(
    (sum, r, idx) => sum + (idx % 2 === 0 ? r?.meta?.changes || 0 : 0),
    0
  );
  return { changed };
}
