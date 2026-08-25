// ═══════════════════════════════════════════════════════════════════════════════
// utils.js — 通用工具函数（CORS、认证、请求解析、速率限制）
// ═══════════════════════════════════════════════════════════════════════════════

// ─── CORS ─────────────────────────────────────────────────────────────────────

/**
 * 生成 CORS 响应头
 * 注意：不使用 Allow-Credentials —— 认证全部走 Authorization Bearer Token，
 * 无 Cookie 会话；允许任意 Origin 是因为公开 API 需支持跨域嵌入场景
 * @param {Request} request — Fetch Request
 * @returns {object} 响应头对象
 */
export function corsHeaders(request) {
  return {
    "Access-Control-Allow-Origin": request.headers.get("Origin") || "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

// ─── 响应构造 ─────────────────────────────────────────────────────────────────

/**
 * 构造 JSON 响应（自动附加 CORS 头）
 * @param {object} data — 响应数据
 * @param {number} status — HTTP 状态码
 * @param {Request} request — Fetch Request（用于 CORS 头）
 * @returns {Response}
 */
export function json(data, status, request) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(request),
    },
  });
}

/**
 * 构造 HTML 响应
 * @param {string} html — HTML 内容
 * @returns {Response}
 */
export function html(content) {
  return new Response(content, {
    headers: { "Content-Type": "text/html;charset=utf-8" },
  });
}

// ─── 认证 ─────────────────────────────────────────────────────────────────────

/**
 * 校验管理员认证 Token
 * @param {Request} request — Fetch Request
 * @param {object} env — Worker 环境变量（含 ADMIN_TOKEN）
 * @returns {Response|null} 认证失败返回 Response，成功返回 null
 */
export function requireAuth(request, env) {
  const authHeader = request.headers.get("Authorization");
  const token = authHeader?.replace("Bearer ", "");
  if (!token || token !== env.ADMIN_TOKEN) {
    return json({ ok: false, error: "未授权，请先登录" }, 401, request);
  }
  return null; // 认证通过
}

// ─── 管理 API 速率限制 ────────────────────────────────────────────────────────

// 滑动窗口配置
const ADMIN_RATE_WINDOW_MS = 60000; // 1 分钟窗口
const ADMIN_RATE_MAX = 120;         // 每 IP 每分钟最多 120 次

// 内存级 IP→时间戳列表映射（Worker 单实例，重启清空）
const adminRateMap = new Map();

/**
 * 清理过期的速率限制记录（惰性清理，每次检查时顺带清理）
 */
export function cleanupAdminRateMap() {
  const now = Date.now();
  for (const [ip, timestamps] of adminRateMap) {
    const valid = timestamps.filter((t) => now - t < ADMIN_RATE_WINDOW_MS);
    if (valid.length === 0) adminRateMap.delete(ip);
    else adminRateMap.set(ip, valid);
  }
}

/**
 * 检查管理 API 速率限制（滑动窗口）
 * @param {Request} request — Fetch Request
 * @returns {{ blocked: boolean, retryAfter?: number } | null}
 */
export function checkAdminRateLimit(request) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const now = Date.now();
  const timestamps = adminRateMap.get(ip) || [];
  const valid = timestamps.filter((t) => now - t < ADMIN_RATE_WINDOW_MS);
  if (valid.length >= ADMIN_RATE_MAX) {
    const oldest = valid[0];
    const retryAfter = Math.ceil((ADMIN_RATE_WINDOW_MS - (now - oldest)) / 1000);
    return { blocked: true, retryAfter };
  }
  valid.push(now);
  adminRateMap.set(ip, valid);
  return null;
}

// ─── 请求解析 ─────────────────────────────────────────────────────────────────

/**
 * 解析 JSON 请求体
 * @param {Request} request — Fetch Request
 * @returns {Promise<{ ok: boolean, data?: object, response?: Response }>}
 */
export async function parseJsonBody(request) {
  try {
    const data = await request.json();
    return { ok: true, data };
  } catch {
    return {
      ok: false,
      response: json({ ok: false, error: "无效的 JSON 请求体" }, 400, request),
    };
  }
}

// ─── URL 工具 ─────────────────────────────────────────────────────────────────

/**
 * URL 协议校验：仅接受 http/https
 * @param {string} url — 待校验 URL
 * @returns {{ ok: boolean, error?: string }}
 */
export function validateUrlProtocol(url) {
  if (!url) return { ok: true };
  try {
    const u = new URL(url);
    if (!["http:", "https:"].includes(u.protocol)) {
      return { ok: false, error: `不支持的协议: ${u.protocol}，仅支持 http/https` };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: `无效的 URL 格式: ${url}` };
  }
}

/**
 * 从 URL 中解析原始 URL、干净 URL 和推广参数
 * 自动剥离 ref/aff/invite 查询参数，返回干净 URL
 * @param {string} rawUrl — 原始 URL
 * @returns {{ originalUrl: string, cleanUrl: string, ref: string }}
 */
export function parseSiteUrl(rawUrl) {
  if (!rawUrl) return { originalUrl: "", cleanUrl: "", ref: "" };
  try {
    const u = new URL(rawUrl);
    const refParam =
      u.searchParams.get("ref") || u.searchParams.get("aff") || u.searchParams.get("invite") || "";
    if (refParam) u.searchParams.delete("ref");
    u.searchParams.delete("aff");
    u.searchParams.delete("invite");
    return { originalUrl: rawUrl, cleanUrl: u.toString(), ref: refParam };
  } catch {
    return { originalUrl: rawUrl, cleanUrl: rawUrl, ref: "" };
  }
}
