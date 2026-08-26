// ═══════════════════════════════════════════════════════════════════════════════
// feedbacks.js — 用户反馈模块
// 用户可在站点卡片提交反馈（报错/纠正/好评），admin 后台审核处理
// ═══════════════════════════════════════════════════════════════════════════════

import { dbAll, dbGet, dbRun, dbBatch } from "./db.js";
import { json as jsonResponse, parseJsonBody } from "./utils.js";

// 每 IP 每天最多 10 次反馈
const FEEDBACK_RATE_LIMIT = 10;
const FEEDBACK_RATE_WINDOW_MS = 86400000;

// 反馈类型枚举
// 支持5种反馈类型（对应 0003 STEP 5 / 0004 migration 中的 CHECK 约束）
// still_works/reported_dead 用于"还能用/已失效"一键反馈，驱动 verified_at 更新
const VALID_TYPES = ["error", "correction", "positive", "still_works", "reported_dead"];
const TYPE_LABELS = { error: "报错", correction: "纠正", positive: "好评", still_works: "还能用", reported_dead: "已失效" };

// 一键反馈类型：类型本身就是完整信号，不需要用户写字。
// 表格视图里的 👍/👎 按钮发的就是这两种，content 为 ""。
// 把"至少 2 个字符"套在它们身上会让按钮 100% 报错 ——
// 实测 POST /api/feedback {type:"still_works",content:""} 返回
// {"ok":false,"error":"反馈内容至少需要 2 个字符"}。
const NO_CONTENT_TYPES = ["still_works", "reported_dead"];

/**
 * 用户提交反馈
 * @param {object} request — Fetch Request
 * @param {object} db — D1 数据库实例
 * @returns {Promise<Response>}
 */
export async function handleSubmitFeedback(request, db) {
  const parsed = await parseJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const { siteName, type, content } = parsed.data;

  // 参数校验
  if (!siteName || typeof siteName !== "string") {
    return jsonResponse({ ok: false, error: "站点名称为必填项" }, 400, request);
  }
  if (!type || !VALID_TYPES.includes(type)) {
    return jsonResponse({ ok: false, error: `反馈类型无效，支持: ${VALID_TYPES.join(", ")}` }, 400, request);
  }

  const oneClick = NO_CONTENT_TYPES.includes(type);
  const text = typeof content === "string" ? content : "";
  if (!oneClick && text.trim().length < 2) {
    return jsonResponse({ ok: false, error: "反馈内容至少需要 2 个字符" }, 400, request);
  }
  if (text.length > 500) {
    return jsonResponse({ ok: false, error: "反馈内容不能超过 500 字符" }, 400, request);
  }

  // 速率限制：每 IP 每天 10 次
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const now = Date.now();
  const recentCount = await dbGet(
    db,
    "SELECT COUNT(*) as count FROM feedbacks WHERE ip = ? AND created_at > datetime(?, 'unixepoch')",
    [ip, Math.floor((now - FEEDBACK_RATE_WINDOW_MS) / 1000)]
  );
  if ((recentCount?.count || 0) >= FEEDBACK_RATE_LIMIT) {
    return jsonResponse(
      { ok: false, error: `每天最多提交 ${FEEDBACK_RATE_LIMIT} 条反馈，请明天再试` },
      429,
      request
    );
  }

  // 验证站点是否存在
  const site = await dbGet(db, "SELECT name FROM sites WHERE name = ?", [siteName]);
  if (!site) {
    return jsonResponse({ ok: false, error: `站点 "${siteName}" 不存在` }, 404, request);
  }

  // 阶段 D：一键反馈驱动鲜度（与 INSERT 同一 batch，原子）。
  // still_works（👍 还能用）= 社区实证可用：写 verified_at 并把失败计数清零，
  //   verified_by='feedback' 区分来源（healthcheck/cron）。这是 docs/09 阶段 D
  //   "最低摩擦鲜度入口"——健康检查 6 小时一次，用户点赞让站点即时变新鲜。
  // reported_dead（👎 已失效）= 只累加失败计数，**不写 verified_at**：
  //   用户可能误报，伪造鲜度比没有更糟；由 cron 后续探测确认、管理员处理。
  //   健康检查的"失败绝不被自动禁用"原则同样适用于用户反馈。
  const statements = [
    db
      .prepare(
        `INSERT INTO feedbacks (site_name, type, content, ip, status, created_at)
         VALUES (?, ?, ?, ?, 'new', datetime('now'))`
      )
      .bind(siteName, type, text.trim(), ip),
  ];
  if (type === "still_works") {
    statements.push(
      db
        .prepare(
          "UPDATE sites SET verified_at = datetime('now'), verified_by = 'feedback', health_fail_count = 0 WHERE name = ?"
        )
        .bind(siteName)
    );
  } else if (type === "reported_dead") {
    statements.push(
      db
        .prepare("UPDATE sites SET health_fail_count = health_fail_count + 1 WHERE name = ?")
        .bind(siteName)
    );
  }
  await dbBatch(db, statements);

  return jsonResponse({ ok: true, message: "感谢您的反馈！" }, 201, request);
}

/**
 * 获取所有反馈列表（admin 专用）
 * @param {object} db — D1 数据库实例
 * @param {string} [status] — 可选：按状态过滤
 * @returns {Promise<object>}
 */
export async function handleGetFeedbacks(db, status) {
  let sql = "SELECT * FROM feedbacks";
  const args = [];
  if (status && ["new", "read", "resolved"].includes(status)) {
    sql += " WHERE status = ?";
    args.push(status);
  }
  sql += " ORDER BY created_at DESC";

  const feedbacks = await dbAll(db, sql, args);
  const totalRow = await dbGet(db, "SELECT COUNT(*) as count FROM feedbacks");
  const unreadRow = await dbGet(db, "SELECT COUNT(*) as count FROM feedbacks WHERE status = 'new'");

  return {
    ok: true,
    feedbacks: feedbacks.map((f) => ({
      id: f.id,
      siteName: f.site_name,
      type: f.type,
      typeLabel: TYPE_LABELS[f.type] || f.type,
      content: f.content,
      ip: f.ip,
      status: f.status,
      createdAt: f.created_at,
    })),
    total: totalRow?.count || 0,
    unread: unreadRow?.count || 0,
  };
}

/**
 * 处理反馈状态变更（admin 专用）
 * @param {object} db — D1 数据库实例
 * @param {number} id — 反馈 ID
 * @param {string} action — read / resolved / delete
 * @returns {Promise<object>}
 */
export async function handleFeedbackAction(db, id, action) {
  if (!id) return { ok: false, error: "需要反馈 ID" };

  if (action === "delete") {
    const result = await dbRun(db, "DELETE FROM feedbacks WHERE id = ?", [id]);
    if (result.meta?.changes === 0) return { ok: false, error: "反馈不存在" };
    return { ok: true, action: "deleted", id };
  }

  if (action === "read" || action === "resolved") {
    const result = await dbRun(
      db,
      "UPDATE feedbacks SET status = ? WHERE id = ?",
      [action === "resolved" ? "resolved" : "read", id]
    );
    if (result.meta?.changes === 0) return { ok: false, error: "反馈不存在" };
    return { ok: true, action, id };
  }

  return { ok: false, error: "action 只能是 read, resolved, delete" };
}
