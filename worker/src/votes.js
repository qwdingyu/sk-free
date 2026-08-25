// ═══════════════════════════════════════════════════════════════════════════════
// votes.js — 投票系统 + 速率限制（D1 版本）
// 从 KV 全量 JSON 重写迁移到 D1 单行 UPSERT
// ═══════════════════════════════════════════════════════════════════════════════

import { dbAll, dbGet, dbRun } from "./db.js";
import { json as jsonResponse, parseJsonBody } from "./utils.js";

// 投票速率限制配置
const RATE_LIMIT_WINDOW_MS = 3600000; // 1 小时滑动窗口
const RATE_LIMIT_MAX = 10;            // 每 IP 每小时最多 10 次投票

/**
 * 获取站点投票列表
 * @param {object} db — D1 数据库实例
 * @returns {Promise<object>} { ok, votes: { siteName: { up, down } } }
 */
export async function handleGetVotes(db) {
  const rows = await dbAll(db, "SELECT site_name, up_count, down_count FROM votes");
  const votes = {};
  for (const row of rows) {
    votes[row.site_name] = { up: row.up_count, down: row.down_count };
  }
  return { ok: true, votes };
}

/**
 * 检查投票速率限制（滑动窗口）
 * @param {object} db — D1 数据库实例
 * @param {string} siteName — 站点名称
 * @param {string} ip — 客户端 IP
 * @returns {Promise<{ blocked: boolean, retryAfter?: number }>}
 */
export async function checkRateLimit(db, siteName, ip) {
  const windowStart = Date.now() - RATE_LIMIT_WINDOW_MS;
  // 清理旧窗口记录
  await dbRun(db, "DELETE FROM rate_limits WHERE window_start < ?", [windowStart]);
  // 查询当前窗口内该 IP 对该站点的投票次数
  const row = await dbGet(
    db,
    "SELECT COUNT(*) as cnt FROM rate_limits WHERE site_name = ? AND ip = ? AND window_start > ?",
    [siteName, ip, windowStart]
  );
  const count = row?.cnt || 0;
  if (count >= RATE_LIMIT_MAX) {
    return { blocked: true, retryAfter: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000) };
  }
  return { blocked: false };
}

/**
 * 记录一次投票（更新速率限制窗口）
 * @param {object} db — D1 数据库实例
 * @param {string} siteName — 站点名称
 * @param {string} ip — 客户端 IP
 */
export async function updateRateLimit(db, siteName, ip) {
  await dbRun(db, "INSERT INTO rate_limits (site_name, ip, window_start) VALUES (?, ?, ?)", [
    siteName,
    ip,
    Date.now(),
  ]);
}

/**
 * 处理投票请求
 * @param {object} request — Fetch Request
 * @param {object} db — D1 数据库实例
 * @returns {Promise<Response>}
 */
export async function handleVote(request, db) {
  const parsed = await parseJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const { siteName, type } = parsed.data;

  if (!siteName || !["up", "down"].includes(type)) {
    return jsonResponse({ ok: false, error: "需要 siteName 和 type (up/down)" }, 400, request);
  }

  // 速率限制检查
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const rateCheck = await checkRateLimit(db, siteName, ip);
  if (rateCheck.blocked) {
    return jsonResponse(
      { ok: false, error: `投票过于频繁，请 ${rateCheck.retryAfter} 秒后再试` },
      429,
      request
    );
  }

  // UPSERT：站点不存在则初始化为 0，然后 +1
  // 按 type 分支硬编码 SQL，避免字段名拼接注入风险
  if (type === "up") {
    await dbRun(
      db,
      `INSERT INTO votes (site_name, up_count, down_count) VALUES (?, 1, 0)
       ON CONFLICT(site_name) DO UPDATE SET up_count = up_count + 1, updated_at = datetime('now')`,
      [siteName]
    );
  } else {
    await dbRun(
      db,
      `INSERT INTO votes (site_name, up_count, down_count) VALUES (?, 0, 1)
       ON CONFLICT(site_name) DO UPDATE SET down_count = down_count + 1, updated_at = datetime('now')`,
      [siteName]
    );
  }

  // 记录速率限制
  await updateRateLimit(db, siteName, ip);

  // 返回最新投票数据
  const voteRow = await dbGet(db, "SELECT up_count, down_count FROM votes WHERE site_name = ?", [siteName]);
  return jsonResponse(
    {
      ok: true,
      siteName,
      up: voteRow?.up_count || 0,
      down: voteRow?.down_count || 0,
    },
    200,
    request
  );
}
