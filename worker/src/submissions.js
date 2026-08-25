// ═══════════════════════════════════════════════════════════════════════════════
// submissions.js — 用户提交审核队列（D1 版本）
// 用户提交站点 → 存入 submissions 表 → 管理员审核（批准/驳回）
// ═══════════════════════════════════════════════════════════════════════════════

import { dbAll, dbGet, dbRun } from "./db.js";
import { json as jsonResponse, parseJsonBody, validateUrlProtocol } from "./utils.js";

// 提交速率限制配置
const SUBMIT_RATE_LIMIT = 5;               // 每 IP 每天最多 5 次
const SUBMIT_RATE_WINDOW_MS = 86400000;     // 24 小时窗口

/**
 * 处理用户提交新站点
 * 提交后存入 submissions 表等待管理员审核，不会立即上线
 * @param {object} request — Fetch Request
 * @param {object} db — D1 数据库实例
 * @returns {Promise<Response>}
 */
export async function handleSubmitSite(request, db) {
  const parsed = await parseJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const { name, url, tags, summary, checkin, models, register, notes } = body;

  if (!name || !url) {
    return jsonResponse({ ok: false, error: "站点名称和 URL 为必填项" }, 400, request);
  }
  if (typeof name !== "string" || typeof url !== "string") {
    return jsonResponse({ ok: false, error: "参数格式错误" }, 400, request);
  }

  // URL 协议校验：仅接受 http/https
  const urlCheck = validateUrlProtocol(url);
  if (!urlCheck.ok) {
    return jsonResponse({ ok: false, error: urlCheck.error }, 400, request);
  }

  // 速率限制：每 IP 每天最多 5 次提交
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const now = Date.now();
  // 用 datetime(?, 'unixepoch') 将秒级时间戳转为 datetime 字符串再比较
  // 避免 epoch 毫秒字符串与 datetime 字符串比较恒为真的 bug
  const ipSubmissions = await dbAll(
    db,
    "SELECT id FROM submissions WHERE ip = ? AND created_at > datetime(?, 'unixepoch')",
    [ip, Math.floor((now - SUBMIT_RATE_WINDOW_MS) / 1000)]
  );
  if (ipSubmissions.length >= SUBMIT_RATE_LIMIT) {
    return jsonResponse(
      { ok: false, error: `每天最多提交 ${SUBMIT_RATE_LIMIT} 次，请明天再试` },
      429,
      request
    );
  }

  // 检查是否与已有站点重名
  const existingSite = await dbGet(db, "SELECT name FROM sites WHERE name = ?", [name]);
  if (existingSite) {
    return jsonResponse({ ok: false, error: `站点 "${name}" 已存在` }, 409, request);
  }

  // 检查是否与待审核提交重名
  const existingSub = await dbGet(
    db,
    "SELECT id FROM submissions WHERE site_name = ? AND status = 'pending'",
    [name]
  );
  if (existingSub) {
    return jsonResponse({ ok: false, error: `站点 "${name}" 已有提交在审核中` }, 409, request);
  }

  const submissionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const siteTags = Array.isArray(tags)
    ? tags
    : (tags || "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
  const siteNotes = Array.isArray(notes) ? JSON.stringify(notes) : null;

  // 插入到 submissions 表
  await dbRun(
    db,
    `INSERT INTO submissions (id, site_name, site_url, site_tags, site_summary, site_checkin, site_models, site_register, site_notes, ip, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'))`,
    [submissionId, name, url, JSON.stringify(siteTags), summary || "", checkin || "", models || "", register || "", siteNotes || "[]", ip]
  );

  return jsonResponse({ ok: true, message: "提交成功，等待管理员审核" }, 201, request);
}

/**
 * 获取待审核提交列表
 * @param {object} db — D1 数据库实例
 * @returns {Promise<object>} { ok, submissions, total }
 */
export async function handleAdminGetSubmissions(db) {
  const pendingSubs = await dbAll(
    db,
    "SELECT * FROM submissions WHERE status = 'pending' ORDER BY created_at DESC"
  );
  const totalRow = await dbGet(db, "SELECT COUNT(*) as count FROM submissions");
  const total = totalRow?.count || 0;

  // 转换为前端期望的格式
  const submissions = pendingSubs.map((sub) => ({
    id: sub.id,
    site: {
      name: sub.site_name,
      url: sub.site_url,
      tags: sub.site_tags ? JSON.parse(sub.site_tags) : [],
      summary: sub.site_summary || "",
      checkin: sub.site_checkin,
      models: sub.site_models,
      register: sub.site_register,
      notes: sub.site_notes ? JSON.parse(sub.site_notes) : [],
    },
    ip: sub.ip,
    createdAt: new Date(sub.created_at).getTime(),
    status: sub.status,
  }));

  return { ok: true, submissions, total };
}

/**
 * 处理提交审核操作（批准/驳回）
 * @param {object} db — D1 数据库实例
 * @param {string} action — "approve_submission" 或 "reject_submission"
 * @param {string} id — 提交 ID
 * @returns {Promise<object>} { ok, action, id } 或 { ok: false, error }
 */
export async function handleAdminSubmissionAction(db, action, id) {
  const sub = await dbGet(db, "SELECT id FROM submissions WHERE id = ?", [id]);
  if (!sub) return { ok: false, error: "提交不存在" };

  const newStatus = action === "approve_submission" ? "approved" : "rejected";
  await dbRun(db, "UPDATE submissions SET status = ? WHERE id = ?", [newStatus, id]);

  return { ok: true, action, id };
}
