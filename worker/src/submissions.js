// ═══════════════════════════════════════════════════════════════════════════════
// submissions.js — 用户提交审核队列（D1 版本）
// 用户提交站点 → 存入 submissions 表 → 管理员审核（批准/驳回）
// ═══════════════════════════════════════════════════════════════════════════════

import { dbAll, dbGet, dbRun, dbBatch } from "./db.js";
import { json as jsonResponse, parseJsonBody, validateUrlProtocol, parseSiteUrl } from "./utils.js";

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
 * SQLite datetime('now') 是**不带时区标记的 UTC 字符串**（"YYYY-MM-DD HH:MM:SS"）。
 * 直接 new Date() 会按 ES 规范当成本地时间解析，UTC+8 环境下展示时间整体
 * 偏移 +8 小时（前端 broadcast/src/20-utils.js 的 parseUtc() 早已记录过同一坑）。
 * 按正则补 UTC 解释，解析失败时回退到默认行为。
 * @param {string} s — "YYYY-MM-DD HH:MM:SS" 或 ISO 字符串
 * @returns {number} UTC 毫秒时间戳
 */
function parseUtcTs(s) {
  if (!s) return 0;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m) return new Date(s).getTime();
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

/**
 * 获取待审核提交列表
 * @param {object} db — D1 数据库实例
 * @returns {Promise<object>} { ok, submissions, total }
 */
export async function handleAdminGetSubmissions(db, status) {
  let sql = "SELECT * FROM submissions";
  const args = [];
  if (status && ["pending", "approved", "rejected"].includes(status)) {
    sql += " WHERE status = ?";
    args.push(status);
  }
  sql += " ORDER BY created_at DESC";

  const subs = await dbAll(db, sql, args);
  const totalRow = await dbGet(db, "SELECT COUNT(*) as count FROM submissions");
  const total = totalRow?.count || 0;

  // 转换为前端期望的格式
  const submissions = subs.map((sub) => ({
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
    createdAt: parseUtcTs(sub.created_at),
    status: sub.status,
  }));

  return { ok: true, submissions, total };
}

/**
 * 原子批准提交：建站 + 标记已批准在同一 db.batch 内完成。
 *
 * 为什么需要它（M6）：原来的批准流程是前端两次独立请求——
 *   POST /api/admin/sites 建站 → POST /api/admin/sites/batch 标记批准。
 * 两步之间任何失败（网络中断、第二步抛错）都会留下"站点已建但 submission
 * 仍为 pending"的半完成状态；重试时第一步会 409 冲突（站点已存在），
 * 管理员无法继续批准，只能手工处理。
 * 这里把 INSERT INTO sites + UPDATE submissions 放进同一个 batch，
 * D1 batch 原子执行，要么都成功要么都不生效。
 *
 * 字段处理与 handleAdminCreateSite 保持一致：URL 经 parseSiteUrl 剥离推广
 * 参数并规范化；tags/notes 容错解析（非法 JSON 当空数组）。
 *
 * @param {object} db — D1 数据库实例
 * @param {string} id — 提交 ID
 * @returns {Promise<object>} { ok, action, id } 或 { ok: false, error }
 */
export async function handleAdminApproveSubmission(db, id) {
  const sub = await dbGet(
    db,
    "SELECT * FROM submissions WHERE id = ? AND status = 'pending'",
    [id]
  );
  if (!sub) return { ok: false, error: "提交不存在或已处理" };

  // 与 handleAdminCreateSite 一致：名称唯一性检查（同名校点已存在则拒绝）
  const existing = await dbGet(db, "SELECT name FROM sites WHERE name = ?", [sub.site_name]);
  if (existing) {
    return { ok: false, error: `站点 "${sub.site_name}" 已存在` };
  }

  // URL 规范化 + 剥离推广参数（与 create/import 流程一致）
  const { originalUrl, cleanUrl, ref } = parseSiteUrl(sub.site_url);
  const parseJsonArr = (raw) => {
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };
  const tags = parseJsonArr(sub.site_tags);
  const notes = parseJsonArr(sub.site_notes);

  await dbBatch(db, [
    db
      .prepare(
        `INSERT INTO sites (name, url, original_url, ref, tags, summary, checkin, models, rate, register, notes,
                            slug, kind, quota_min, quota_max, quota_unit, quota_period, quota_calls_est, quota_tier, quota_raw, needs_proxy,
                            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 datetime('now'), datetime('now'))`
      )
      .bind(
        sub.site_name,
        cleanUrl,
        originalUrl && originalUrl !== cleanUrl ? originalUrl : "",
        ref || "",
        JSON.stringify(tags),
        sub.site_summary || "",
        sub.site_checkin || "",
        sub.site_models || "",
        "", // submissions 表无 rate 字段，按空处理
        sub.site_register || "",
        JSON.stringify(notes),
        // 结构化字段：提交表单不含这些，用默认值确保前端不显示"额度未知"
        null, // slug
        "api_site", // kind
        null, null, null, // quota_min, quota_max, quota_unit
        "none", // quota_period
        null, // quota_calls_est
        "none", // quota_tier
        sub.site_checkin || null, // quota_raw 用 checkin 兜底
        null  // needs_proxy
      ),
    db.prepare("UPDATE submissions SET status = 'approved' WHERE id = ?").bind(id),
  ]);

  return { ok: true, action: "approved", id };
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

/**
 * 批量处理提交审核操作（批准/驳回）
 * @param {object} db — D1 数据库实例
 * @param {string} action — "approve_submission" 或 "reject_submission"
 * @param {number[]} ids — 提交 ID 数组
 * @returns {Promise<object>} { ok, action, success, failed, results }
 */
export async function handleAdminBatchSubmissions(db, action, ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    return { ok: false, error: "需要 ids 数组" };
  }
  if (!["approve_submission", "reject_submission"].includes(action)) {
    return { ok: false, error: "action 只能是 approve_submission 或 reject_submission" };
  }

  const cleanIds = ids.map((id) => {
    if (typeof id === "number" && !Number.isNaN(id)) return id;
    if (typeof id === "string") {
      const trimmed = id.trim();
      if (!trimmed) return NaN;
      // 提交 ID 可能是纯数字字符串，也可能是带字母的字符串（如 "1787566350487-p9tks9"）
      // parseInt 会截断带字母的 ID，导致查询失败。保留原始字符串。
      return trimmed;
    }
    return NaN;
  }).filter((id) => {
    if (typeof id === "number") return !Number.isNaN(id);
    if (typeof id === "string") return id.length > 0;
    return false;
  });
  if (cleanIds.length === 0) {
    return { ok: false, error: "ids 必须是非空数字数组" };
  }

  const results = [];
  for (const id of cleanIds) {
    try {
      if (action === "approve_submission") {
        const result = await handleAdminApproveSubmission(db, id);
        results.push({ id, ok: result.ok, error: result.error || null });
      } else {
        const result = await handleAdminSubmissionAction(db, action, id);
        results.push({ id, ok: result.ok, error: result.error || null });
      }
    } catch (e) {
      results.push({ id, ok: false, error: e.message || "未知错误" });
    }
  }

  const success = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;

  return {
    ok: true,
    action,
    success,
    failed,
    results,
  };
}
