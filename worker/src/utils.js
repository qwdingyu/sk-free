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
 * 判断 IPv4 是否属于私有/保留/回环/链路本地等不可外联网段（SSRF 防护）
 * 覆盖：0.0.0.0/8、10/8、127/8、169.254/16、172.16/12、192.168/16、
 *       100.64/10（CGNAT）、192.0.0.0/24、198.18/15、192.88.99/24、224+（组播）
 * @param {string} ip — IPv4 字符串
 * @returns {boolean} true = 不允许外联
 */
function isPrivateIPv4(ip) {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b, c] = [m[1], m[2], m[3]].map(Number);
  if ([a, b, c, Number(m[4])].some((n) => n > 255)) return false;
  if (a === 0) return true;                            // 0.0.0.0/8
  if (a === 10) return true;                           // 10.0.0.0/8
  if (a === 127) return true;                          // 127.0.0.0/8 回环
  if (a === 169 && b === 254) return true;             // 169.254.0.0/16 链路本地（云元数据在此段）
  if (a === 172 && b >= 16 && b <= 31) return true;    // 172.16.0.0/12
  if (a === 192 && b === 168) return true;             // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true;   // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0 && c === 0) return true;    // 192.0.0.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 基准测试
  if (a === 192 && b === 88 && c === 99) return true;  // 192.88.99.0/24
  if (a >= 224) return true;                           // 224+ 组播/保留
  return false;
}

/**
 * IPv4-mapped IPv6（::ffff:x.x.x.x）的尾段判定。
 * Node 的 URL 会把 ::ffff:127.0.0.1 规范化为 ::ffff:7f00:1（十六进制），
 * 所以这里同时支持点分与十六进制两种形态。
 * @param {string} tail — "::ffff:" 之后的剩余部分
 * @returns {boolean} true = 不允许外联
 */
function isMappedIPv4(tail) {
  if (tail.includes(".")) return isPrivateIPv4(tail);
  const parts = tail.split(":");
  let n;
  // 用乘法而不是 <<：JS 的 << 是 32 位有符号运算，0xc0a8 << 16 会变成负数，
  // 被下面的 n < 0 误判为"非 IPv4 映射"而放行（实测 ::ffff:192.168.1.1 漏网）。
  if (parts.length === 2) n = parseInt(parts[0], 16) * 0x10000 + parseInt(parts[1], 16);
  else if (parts.length === 1) n = parseInt(parts[0], 16);
  else return false;
  if (!Number.isFinite(n) || n < 0 || n > 0xffffffff) return false;
  return isPrivateIPv4(
    [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".")
  );
}

/**
 * 判断 hostname 是否指向不可外联的目标（SSRF 防护）
 * 覆盖：localhost、裸 IPv4 私有段、IPv6 回环/链路本地/ULA/IPv4 映射。
 * 局限：无法在应用层预判"域名最终解析到哪"（DNS rebinding 需配合网络层
 * 防护，如 Cloudflare 的 egress 过滤），这里挡的是直接写 IP/本机名的常见面。
 * @param {string} hostname — URL 的 hostname（无端口、可能带 [] 的 IPv6）
 * @returns {boolean} true = 不允许外联
 */
function isPrivateHost(hostname) {
  let h = (hostname || "").toLowerCase().replace(/\.$/, ""); // 去 FQDN 尾点
  if (!h) return true;
  if (h === "localhost" || h === "0.0.0.0") return true;

  // IPv6（可能带方括号）
  if (h.includes(":")) {
    const v6 = h.replace(/^\[|\]$/g, "");
    if (v6 === "::1") return true;                       // 回环
    if (v6.startsWith("::ffff:")) return isMappedIPv4(v6.slice(7)); // IPv4 映射
    if (/^fe[89ab]/.test(v6)) return true;               // fe80::/10 链路本地
    if (/^fc|^fd/.test(v6)) return true;                 // fc00::/7 ULA
    return false;
  }
  return isPrivateIPv4(h);
}

/**
 * URL 协议与目标校验：仅接受 http/https 且不允许内网/保留地址（SSRF 防护）
 * create/update/submissions/import/check 全部走这里。
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
    // M3 修复：此前只查 scheme，http://169.254.169.254（云元数据）、
    // http://127.0.0.1、http://192.168.x.x 等可入库并被 cron 每 6 小时访问，
    // 构成盲 SSRF。host 层一并拦截。
    if (isPrivateHost(u.hostname)) {
      return { ok: false, error: `不允许的内网/保留地址: ${u.hostname}` };
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
