/**
 * sk-free Worker API
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * 公开 API（无需认证）：
 *   GET  /api/votes      → 返回所有站点的投票数据
 *   POST /api/vote       → 提交投票（👍/👎）
 *   POST /api/submit     → 用户提交新站点（需登录态校验）
 *   GET  /api/sites      → 返回站点列表（前端渲染用，仅返回 enabled 站点）
 *   GET  /api/health     → 健康检查
 *
 * 管理 API（需 Bearer Token 认证）：
 *   GET    /api/admin/sites          → 列出所有站点（含 disabled）
 *   POST   /api/admin/sites          → 创建新站点
 *   POST   /api/admin/sites/import   → 批量导入（智能 URL 解析 + 去重）
 *   PUT    /api/admin/sites/:name    → 更新站点（含 enabled 切换）
 *   DELETE /api/admin/sites/:name    → 删除站点
 *   POST   /api/admin/sites/batch    → 批量操作（delete/tag/enable/disable）
 *   GET    /api/admin/export         → 导出完整 sites.json
 *   GET    /api/admin/submissions    → 查看待审核提交
 *
 * 管理页面：
 *   GET /admin                       → 管理界面 HTML
 *
 * 存储：Cloudflare KV
 *   - sites.json    → 站点数据（管理 API 读写，公开 API 只读）
 *   - votes.json    → 投票数据
 *   - rate_limits   → 投票速率限制
 *
 * 部署：npx wrangler deploy
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// ── 配置 ──────────────────────────────────────────────────────────────────────

// 允许访问 API 的前端域名（CORS 白名单）
const ALLOWED_ORIGINS = [
  "https://free.eforge.xyz",
  "https://chenjh16.github.io",
  "http://localhost:8787",
  "http://127.0.0.1:8787"
];

// 速率限制：同一 IP 对同一站点的投票冷却时间（毫秒）
const RATE_LIMIT_MS = 60 * 60 * 1000; // 1 小时

// KV 存储的 key 名称
const SITES_KEY = "sites.json";
const VOTES_KEY = "votes.json";
const RATE_KEY = "rate_limits";
const SUBMISSIONS_KEY = "submissions.json";
const DEAD_URLS_KEY = "dead_urls.json";
const SCHEMA_KEY = "schema.json";

// 默认 Schema 定义（sk-free 项目默认配置）
const DEFAULT_SCHEMA = {
  name: "Sk-free API Broadcast",
  description: "收录可注册、可签到、可生图的站点入口",
  fields: [
    { key: "name", label: "站点名称", type: "text", required: true, unique: true },
    { key: "url", label: "站点链接", type: "url", required: true, healthCheck: true },
    { key: "tags", label: "标签", type: "tags", options: ["签到", "生图", "DC系", "半DC", "非DC", "限免", "抽奖"] },
    { key: "summary", label: "站点简介", type: "textarea", max: 200 },
    { key: "checkin", label: "签到额度", type: "text" },
    { key: "models", label: "支持模型", type: "text" },
    { key: "rate", label: "倍率", type: "text" },
    { key: "register", label: "注册方式", type: "text" },
    { key: "notes", label: "备注", type: "list" }
  ],
  tags: ["签到", "生图", "DC系", "半DC", "非DC", "限免", "抽奖"],
  display: {
    layout: "grid",
    columns: 3,
    sortBy: "default",
    priorityTags: ["全部", "签到", "生图", "限免"]
  },
  submit: {
    enabled: true,
    rateLimit: { max: 5, window: "24h" },
    fields: ["name", "url", "tags", "summary", "checkin", "models", "register"]
  },
  healthCheck: {
    enabled: true,
    timeout: 5000,
    autoBlock: true,
    blockOnImport: true
  },
  theme: {
    primary: "#087f78",
    accent: "#b8e35a",
    style: "minimal"
  }
};

/**
 * 从 KV 获取 Schema，不存在则返回默认值
 */
async function getSchema(kv) {
  const raw = await kv.get(SCHEMA_KEY);
  if (!raw) return DEFAULT_SCHEMA;
  try {
    const schema = JSON.parse(raw);
    // 合并默认值（新字段自动补全）
    return {
      ...DEFAULT_SCHEMA,
      ...schema,
      fields: schema.fields || DEFAULT_SCHEMA.fields,
      tags: schema.tags || DEFAULT_SCHEMA.tags,
      display: { ...DEFAULT_SCHEMA.display, ...(schema.display || {}) },
      submit: { ...DEFAULT_SCHEMA.submit, ...(schema.submit || {}) },
      healthCheck: { ...DEFAULT_SCHEMA.healthCheck, ...(schema.healthCheck || {}) },
      theme: { ...DEFAULT_SCHEMA.theme, ...(schema.theme || {}) }
    };
  } catch {
    return DEFAULT_SCHEMA;
  }
}

/**
 * 保存 Schema 到 KV
 */
async function saveSchema(kv, schema) {
  await kv.put(SCHEMA_KEY, JSON.stringify(schema));
}

/**
 * Schema 驱动的字段校验
 * 校验提交数据是否符合 Schema 中定义的字段规则
 * @returns {{ ok: boolean, error?: string }}
 */
function validateSiteFields(schema, data, mode = "create") {
  const fields = schema.fields || [];
  for (const field of fields) {
    const value = data[field.key];
    // 必填校验
    if (field.required && (value === undefined || value === null || value === "")) {
      return { ok: false, error: `${field.label} 为必填项` };
    }
    // 类型校验
    if (value !== undefined && value !== null && value !== "") {
      if (field.type === "url" && typeof value === "string") {
        const urlCheck = validateUrlProtocol(value);
        if (!urlCheck.ok) return { ok: false, error: `${field.label}: ${urlCheck.error}` };
      }
      if (field.type === "text" && typeof value !== "string") {
        return { ok: false, error: `${field.label} 必须是文本` };
      }
      if (field.type === "number" && typeof value !== "number") {
        return { ok: false, error: `${field.label} 必须是数字` };
      }
      if (field.type === "textarea" && typeof value !== "string") {
        return { ok: false, error: `${field.label} 必须是文本` };
      }
      if (field.type === "tags" && !Array.isArray(value) && typeof value !== "string") {
        return { ok: false, error: `${field.label} 必须是标签数组或逗号分隔文本` };
      }
      // 最大长度校验
      if (field.max && typeof value === "string" && value.length > field.max) {
        return { ok: false, error: `${field.label} 不能超过 ${field.max} 个字符` };
      }
    }
  }
  return { ok: true };
}

/**
 * Schema 驱动的字段填充（补充默认值、标准化格式）
 */
function normalizeSiteFields(schema, data) {
  const result = { ...data };
  for (const field of schema.fields || []) {
    const key = field.key;
    if (result[key] === undefined || result[key] === null) {
      // 设置默认值
      if (field.type === "tags") result[key] = [];
      else if (field.type === "list") result[key] = [];
      else if (field.type === "boolean") result[key] = false;
      else if (field.type === "number") result[key] = 0;
      else result[key] = "";
    }
    // 标准化 tags
    if (field.type === "tags" && typeof result[key] === "string") {
      result[key] = result[key].split(",").map((t) => t.trim()).filter(Boolean);
    }
  }
  return result;
}

// 用户提交速率限制：每 IP 每天最多提交次数
const SUBMIT_RATE_LIMIT = 5; // 每 IP 每天 5 次
const SUBMIT_RATE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 小时

// 管理 API 速率限制：每 IP 每窗口允许的请求次数
const ADMIN_RATE_WINDOW_MS = 10 * 60 * 1000; // 10 分钟滑动窗口
const ADMIN_RATE_LIMIT = 100; // 每 IP 每窗口最多 100 次管理 API 请求
// 导入数量上限（保护 CPU 时间不超过 10ms 限制）
const IMPORT_MAX_BATCH = 200;
const adminRateMap = new Map(); // IP → { count, windowStart }

/**
 * 管理 API 基于 IP 的滑动窗口速率限制
 * 返回 null 表示允许，返回 Response 表示被限流
 */
function checkAdminRateLimit(request) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const now = Date.now();
  const entry = adminRateMap.get(ip);

  // 过期则重置窗口
  if (!entry || now - entry.windowStart > ADMIN_RATE_WINDOW_MS) {
    adminRateMap.set(ip, { count: 1, windowStart: now });
    return null;
  }

  if (entry.count >= ADMIN_RATE_LIMIT) {
    const retryAfter = Math.ceil((ADMIN_RATE_WINDOW_MS - (now - entry.windowStart)) / 1000);
    return { retryAfter };
  }

  entry.count++;
  return null;
}

// 定期清理过期条目（每 30 分钟）
let lastCleanup = Date.now();
function cleanupAdminRateMap() {
  const now = Date.now();
  if (now - lastCleanup < 30 * 60 * 1000) return;
  lastCleanup = now;
  for (const [ip, entry] of adminRateMap) {
    if (now - entry.windowStart > ADMIN_RATE_WINDOW_MS) adminRateMap.delete(ip);
  }
}

/**
 * 智能 URL 解析：剥离推广参数，提取干净 URL 和邀请码
 * 返回 { cleanUrl, ref, originalUrl }
 *   originalUrl = 原始 URL（保留所有参数，用于溯源）
 *   cleanUrl    = 剥离 aff/ref/invite 等参数后的 URL（作为唯一标识）
 *   ref         = 被剥离的推广参数原文（如 "aff=FWQS&ref=abc"）
 */
function parseSiteUrl(rawUrl) {
  const originalUrl = rawUrl;
  try {
    const url = new URL(rawUrl);
    // 仅允许 http/https 协议，拒绝 javascript:、file:、data: 等
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { originalUrl, cleanUrl: rawUrl, ref: undefined, error: "仅支持 http/https 协议" };
    }
    const stripParams = ["aff", "ref", "invite", "invite_code", "start"];
    const stripped = [];
    for (const key of stripParams) {
      if (url.searchParams.has(key)) {
        stripped.push(`${key}=${url.searchParams.get(key)}`);
        url.searchParams.delete(key);
      }
    }
    return { originalUrl, cleanUrl: url.toString(), ref: stripped.join("&") || undefined };
  } catch {
    return { originalUrl, cleanUrl: rawUrl, ref: undefined };
  }
}

/**
 * 校验 URL 协议是否为 http/https（拒绝 javascript:/file:/data: 等）
 * @param {string} rawUrl - 原始 URL
 * @returns {{ ok: boolean, error?: string }}
 */
function validateUrlProtocol(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { ok: false, error: "仅支持 http/https 协议" };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "URL 格式无效" };
  }
}

/**
 * 安全解析请求体 JSON
 * 返回 { ok: true, data } 或 { ok: false, response }
 */
async function parseJsonBody(request) {
  try {
    const data = await request.json();
    return { ok: true, data };
  } catch {
    return { ok: false, response: json({ ok: false, error: "请求体不是有效的 JSON" }, 400, request) };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 构造 CORS 响应头
 */
function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  if (!ALLOWED_ORIGINS.includes(origin)) {
    return {};
  }
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400"
  };
}

/**
 * JSON 响应封装
 */
function json(data, status, request) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(request) }
  });
}

/**
 * HTML 响应封装
 */
function html(content, status = 200) {
  return new Response(content, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}

/**
 * 从请求头提取 Bearer Token
 */
function extractToken(request) {
  const auth = request.headers.get("Authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

/**
 * 管理员认证中间件
 * 验证 Bearer Token 是否匹配 ADMIN_TOKEN 环境变量
 * 返回 null 表示认证通过，返回 Response 表示认证失败
 */
function requireAuth(request, env) {
  const token = extractToken(request);
  const adminToken = env.ADMIN_TOKEN || "";
  if (!token || !adminToken || token !== adminToken) {
    return json({ ok: false, error: "未授权，请先登录" }, 401, request);
  }
  return null; // 认证通过
}

// ═══════════════════════════════════════════════════════════════════════════════
// 投票 API
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 获取投票数据
 */
async function handleGetVotes(kv, request) {
  const raw = await kv.get(VOTES_KEY);
  const votes = raw ? JSON.parse(raw) : {};
  return json({ ok: true, votes }, 200, request);
}

/**
 * 速率限制检查
 */
async function checkRateLimit(kv, siteName, ip) {
  const raw = await kv.get(RATE_KEY);
  const limits = raw ? JSON.parse(raw) : {};
  const lastVote = limits[siteName]?.[ip] || 0;
  const now = Date.now();

  if (now - lastVote < RATE_LIMIT_MS) {
    const remaining = Math.ceil((RATE_LIMIT_MS - (now - lastVote)) / 60000);
    return { allowed: false, retryAfter: remaining };
  }
  return { allowed: true };
}

/**
 * 更新速率限制
 */
async function updateRateLimit(kv, siteName, ip) {
  const raw = await kv.get(RATE_KEY);
  const limits = raw ? JSON.parse(raw) : {};

  if (!limits[siteName]) limits[siteName] = {};
  limits[siteName][ip] = Date.now();

  // 清理过期条目（仅保留最近 2 小时）
  const cutoff = Date.now() - 2 * RATE_LIMIT_MS;
  for (const site of Object.keys(limits)) {
    for (const entryIp of Object.keys(limits[site])) {
      if (limits[site][entryIp] < cutoff) delete limits[site][entryIp];
    }
    if (Object.keys(limits[site]).length === 0) delete limits[site];
  }

  await kv.put(RATE_KEY, JSON.stringify(limits));
}

/**
 * 检查 URL 是否可达
 * 使用 HEAD 请求 + 5 秒超时，失败后降级为 GET
 * @param {string} url - 要检查的 URL
 * @returns {Promise<{ok: boolean, status: number, error?: string}>}
 */
async function checkUrlHealth(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // 先尝试 HEAD（轻量）
    let res;
    try {
      res = await fetch(url, { method: "HEAD", signal: controller.signal, redirect: "follow" });
    } catch {
      // HEAD 失败（如 405）降级为 GET
      res = await fetch(url, { method: "GET", signal: controller.signal, redirect: "follow" });
    }
    clearTimeout(timer);
    return { ok: res.ok, status: res.status };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, status: 0, error: e.name === "AbortError" ? "timeout" : e.message };
  }
}

/**
 * 获取死链接列表
 */
async function getDeadUrls(kv) {
  const raw = await kv.get(DEAD_URLS_KEY);
  return raw ? JSON.parse(raw) : {};
}

/**
 * 保存死链接列表
 */
async function saveDeadUrls(kv, deadUrls) {
  await kv.put(DEAD_URLS_KEY, JSON.stringify(deadUrls));
}

/**
 * 处理投票
 */
async function handleVote(request, kv) {
  const parsed = await parseJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const { site, vote } = parsed.data;

  if (!site || typeof site !== "string") {
    return json({ ok: false, error: "缺少 site 参数" }, 400, request);
  }
  if (vote !== "up" && vote !== "down") {
    return json({ ok: false, error: "vote 必须是 up 或 down" }, 400, request);
  }

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";

  const rateCheck = await checkRateLimit(kv, site, ip);
  if (!rateCheck.allowed) {
    return json({
      ok: false,
      error: `投票过于频繁，请 ${rateCheck.retryAfter} 分钟后再试`
    }, 429, request);
  }

  const raw = await kv.get(VOTES_KEY);
  const votes = raw ? JSON.parse(raw) : {};

  if (!votes[site]) votes[site] = { up: 0, down: 0 };
  votes[site][vote] = (votes[site][vote] || 0) + 1;

  await kv.put(VOTES_KEY, JSON.stringify(votes));
  await updateRateLimit(kv, site, ip);

  return json({ ok: true, votes: votes[site] }, 200, request);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 管理 API
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 获取完整 sites.json 数据
 */
async function handleGetSites(kv) {
  const raw = await kv.get(SITES_KEY);
  if (!raw) return { metadata: { title: "Sk-free API Broadcast", updatedAt: new Date().toISOString().slice(0, 10) }, sites: [] };
  try {
    return JSON.parse(raw);
  } catch {
    return { metadata: { title: "Sk-free API Broadcast", updatedAt: new Date().toISOString().slice(0, 10) }, sites: [] };
  }
}

/**
 * 获取仅包含已启用站点的数据（前端公开 API 用）
 * 过滤掉 enabled === false 的站点，兼容无 enabled 字段的旧数据（默认启用）
 */
async function handleGetEnabledSites(kv) {
  const data = await handleGetSites(kv);
  return {
    ok: true,
    ...data,
    sites: data.sites.filter((s) => s.enabled !== false)
  };
}

/**
 * 保存完整 sites.json 到 KV
 */
async function saveSites(kv, data) {
  data.metadata = data.metadata || {};
  data.metadata.updatedAt = new Date().toISOString().slice(0, 10);
  await kv.put(SITES_KEY, JSON.stringify(data, null, 2));
}

/**
 * GET /api/admin/sites — 列出所有站点
 */
async function handleAdminListSites(kv, request) {
  const data = await handleGetSites(kv);
  return json({ ok: true, ...data }, 200, request);
}

/**
 * POST /api/admin/sites — 创建新站点
 */
async function handleAdminCreateSite(kv, request) {
  const parsed = await parseJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const { name, url, tags, summary, checkin, models, rate, register, notes } = body;

  if (!name || !url) {
    return json({ ok: false, error: "name 和 url 为必填项" }, 400, request);
  }

  // URL 协议校验：仅接受 http/https
  const urlCheck = validateUrlProtocol(url);
  if (!urlCheck.ok) {
    return json({ ok: false, error: urlCheck.error }, 400, request);
  }

  const data = await handleGetSites(kv);

  // 检查重名
  if (data.sites.some((s) => s.name === name)) {
    return json({ ok: false, error: `站点 "${name}" 已存在` }, 409, request);
  }

  const site = { name, url, tags: tags || [], summary: summary || "", enabled: body.enabled !== false };
  if (checkin) site.checkin = checkin;
  if (models) site.models = models;
  if (rate) site.rate = rate;
  if (register) site.register = register;
  if (notes && notes.length) site.notes = notes;
  if (body.ref) site.ref = body.ref;
  if (body.originalUrl) site.originalUrl = body.originalUrl;

  data.sites.push(site);
  await saveSites(kv, data);

  return json({ ok: true, site }, 200, request);
}

/**
 * PUT /api/admin/sites/:name — 更新站点
 */
async function handleAdminUpdateSite(kv, request, siteName) {
  const parsed = await parseJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const data = await handleGetSites(kv);

  const index = data.sites.findIndex((s) => s.name === siteName);
  if (index === -1) {
    return json({ ok: false, error: `站点 "${siteName}" 不存在` }, 404, request);
  }

  // URL 协议校验：仅接受 http/https
  if (body.url) {
    const urlCheck = validateUrlProtocol(body.url);
    if (!urlCheck.ok) {
      return json({ ok: false, error: urlCheck.error }, 400, request);
    }
  }

  // 合并更新（保留未提供的字段）
  const existing = data.sites[index];
  const updated = {
    name: body.name ?? existing.name,
    url: body.url ?? existing.url,
    tags: body.tags ?? existing.tags,
    summary: body.summary ?? existing.summary,
    checkin: body.checkin ?? existing.checkin,
    models: body.models ?? existing.models,
    rate: body.rate ?? existing.rate,
    register: body.register ?? existing.register,
    notes: body.notes ?? existing.notes,
    ref: body.ref ?? existing.ref,
    originalUrl: body.originalUrl ?? existing.originalUrl,
    enabled: body.enabled !== undefined ? body.enabled : (existing.enabled !== false)
  };

  // 清除 undefined 字段
  Object.keys(updated).forEach((k) => updated[k] === undefined && delete updated[k]);

  data.sites[index] = updated;
  await saveSites(kv, data);

  return json({ ok: true, site: updated }, 200, request);
}

/**
 * DELETE /api/admin/sites/:name — 删除站点
 */
async function handleAdminDeleteSite(kv, request, siteName) {
  const data = await handleGetSites(kv);
  const index = data.sites.findIndex((s) => s.name === siteName);

  if (index === -1) {
    return json({ ok: false, error: `站点 "${siteName}" 不存在` }, 404, request);
  }

  data.sites.splice(index, 1);
  await saveSites(kv, data);

  return json({ ok: true, deleted: siteName }, 200, request);
}

/**
 * POST /api/admin/sites/batch — 批量操作
 * body: { action: "delete" | "add_tag" | "remove_tag", names: string[], tag?: string }
 */
async function handleAdminBatch(kv, request) {
  const parsed = await parseJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const { action, names, tag } = body;

  if (!action || !Array.isArray(names) || names.length === 0) {
    return json({ ok: false, error: "需要 action 和 names 参数" }, 400, request);
  }

  const data = await handleGetSites(kv);
  let affected = 0;

  if (action === "delete") {
    const nameSet = new Set(names);
    const before = data.sites.length;
    data.sites = data.sites.filter((s) => !nameSet.has(s.name));
    affected = before - data.sites.length;
  } else if (action === "enable" || action === "disable") {
    const nameSet = new Set(names);
    const enableVal = action === "enable";
    data.sites.forEach((s) => {
      if (!nameSet.has(s.name)) return;
      s.enabled = enableVal;
      affected++;
    });
  } else if (action === "add_tag" || action === "remove_tag") {
    if (!tag) return json({ ok: false, error: "add_tag/remove_tag 需要 tag 参数" }, 400, request);
    const nameSet = new Set(names);
    data.sites.forEach((s) => {
      if (!nameSet.has(s.name)) return;
      if (!s.tags) s.tags = [];
      if (action === "add_tag" && !s.tags.includes(tag)) {
        s.tags.push(tag);
        affected++;
      } else if (action === "remove_tag") {
        const idx = s.tags.indexOf(tag);
        if (idx !== -1) { s.tags.splice(idx, 1); affected++; }
      }
    });
  } else {
    return json({ ok: false, error: `未知操作: ${action}` }, 400, request);
  }

  await saveSites(kv, data);
  return json({ ok: true, action, affected }, 200, request);
}

/**
 * POST /api/admin/sites/batch — 提交审核操作（批准/驳回）
 * 这些操作作用于 submissions.json 而非 sites.json
 */
async function handleAdminSubmissionAction(kv, request, action, id) {
  const raw = await kv.get(SUBMISSIONS_KEY);
  const subs = raw ? JSON.parse(raw) : [];
  const idx = subs.findIndex((s) => s.id === id);
  if (idx === -1) return json({ ok: false, error: "提交不存在" }, 404, request);

  subs[idx].status = action === "approve_submission" ? "approved" : "rejected";
  await kv.put(SUBMISSIONS_KEY, JSON.stringify(subs));
  return json({ ok: true, action, id }, 200, request);
}

/**
 * GET /api/admin/export — 导出完整 sites.json
 */
async function handleAdminExport(kv, request) {
  const data = await handleGetSites(kv);
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="sites-${data.metadata?.updatedAt || "export"}.json"`,
      ...corsHeaders(request)
    }
  });
}

/**
 * POST /api/admin/sites/import — 批量导入站点
 * 自动剥离 URL 中的推广参数（aff/ref/invite），以干净 URL 去重
 * 请求体：{ sites: [{name, url, tags?, summary?, ...}], overwrite?: bool }
 * 返回：{ imported, added, skipped, duplicates[] }
 */
async function handleAdminImportSites(kv, request) {
  const parsed = await parseJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const { sites: incoming, overwrite = false } = body;

  if (!Array.isArray(incoming) || incoming.length === 0) {
    return json({ ok: false, error: "需要 sites 数组" }, 400, request);
  }
  if (incoming.length > IMPORT_MAX_BATCH) {
    return json({ ok: false, error: `单次最多导入 ${IMPORT_MAX_BATCH} 条` }, 400, request);
  }

  const data = await handleGetSites(kv);

  // 构建现有站点的干净 URL → 索引映射（用于去重和覆盖）
  const existingCleanUrls = new Map();
  data.sites.forEach((s, i) => {
    const { cleanUrl } = parseSiteUrl(s.url);
    existingCleanUrls.set(cleanUrl, i);
  });

  // 加载死链接列表，导入时过滤
  const deadUrls = await getDeadUrls(kv);

  let added = 0, skipped = 0, updated = 0, deadFiltered = 0;
  const duplicates = [];

  for (const item of incoming) {
    if (!item.name || !item.url) { skipped++; continue; }

    // 死链接过滤：URL 在死名单中则跳过
    const { cleanUrl: checkUrl } = parseSiteUrl(item.url);
    if (deadUrls[checkUrl] || deadUrls[item.url]) {
      deadFiltered++;
      continue;
    }

    const { originalUrl, cleanUrl, ref } = parseSiteUrl(item.url);
    const existingIdx = existingCleanUrls.get(cleanUrl);

    if (existingIdx !== undefined) {
      if (overwrite) {
        // 覆盖模式：更新现有站点
        const existing = data.sites[existingIdx];
        data.sites[existingIdx] = {
          ...existing,
          ...Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined && v !== "")),
          url: cleanUrl, // 统一使用干净 URL
          originalUrl: originalUrl || existing.originalUrl, // 保留原始 URL
          ref: ref || existing.ref // 保留原 ref 或使用新解析的
        };
        updated++;
      } else {
        // 跳过重复
        duplicates.push({ name: item.name, url: cleanUrl, existingName: data.sites[existingIdx].name });
        skipped++;
      }
      continue;
    }

    // 新站点：添加到列表
    const site = { name: item.name, url: cleanUrl, tags: item.tags || [], summary: item.summary || "" };
    if (originalUrl && originalUrl !== cleanUrl) site.originalUrl = originalUrl; // 保留原始 URL（仅当与干净 URL 不同时）
    if (item.checkin) site.checkin = item.checkin;
    if (item.models) site.models = item.models;
    if (item.rate) site.rate = item.rate;
    if (item.register) site.register = item.register;
    if (item.notes && item.notes.length) site.notes = item.notes;
    if (ref) site.ref = ref;
    data.sites.push(site);
    existingCleanUrls.set(cleanUrl, data.sites.length - 1);
    added++;
  }

  await saveSites(kv, data);

  return json({
    ok: true,
    imported: incoming.length,
    added,
    updated,
    skipped,
    deadFiltered: deadFiltered > 0 ? deadFiltered : undefined,
    duplicates: duplicates.length > 0 ? duplicates : undefined
  }, 200, request);
}

/**
 * POST /api/submit — 用户提交新站点
 * 请求体：{ name, url, tags?, summary?, checkin?, models?, register?, notes? }
 * 提交后存入 submissions.json 等待管理员审核，不会立即上线
 * 速率限制：每 IP 每天最多 5 次
 */
async function handleSubmitSite(request, kv) {
  const parsed = await parseJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const { name, url, tags, summary, checkin, models, register, notes } = body;

  if (!name || !url) {
    return json({ ok: false, error: "站点名称和 URL 为必填项" }, 400, request);
  }
  if (typeof name !== "string" || typeof url !== "string") {
    return json({ ok: false, error: "参数格式错误" }, 400, request);
  }

  // URL 协议校验：仅接受 http/https
  const urlCheck = validateUrlProtocol(url);
  if (!urlCheck.ok) {
    return json({ ok: false, error: urlCheck.error }, 400, request);
  }

  // 速率限制：每 IP 每天最多 5 次提交
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const raw = await kv.get(SUBMISSIONS_KEY);
  const subs = raw ? JSON.parse(raw) : [];
  const now = Date.now();
  const ipSubmissions = subs.filter((s) => s.ip === ip && (now - s.createdAt) < SUBMIT_RATE_WINDOW_MS);
  if (ipSubmissions.length >= SUBMIT_RATE_LIMIT) {
    return json({ ok: false, error: `每天最多提交 ${SUBMIT_RATE_LIMIT} 次，请明天再试` }, 429, request);
  }

  // 检查是否与已有站点或待审核提交重名
  const data = await handleGetSites(kv);
  if (data.sites.some((s) => s.name === name)) {
    return json({ ok: false, error: `站点 "${name}" 已存在` }, 409, request);
  }
  if (subs.some((s) => s.site.name === name)) {
    return json({ ok: false, error: `站点 "${name}" 已有提交在审核中` }, 409, request);
  }

  const submission = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    site: {
      name,
      url,
      tags: Array.isArray(tags) ? tags : (tags || "").split(",").map((t) => t.trim()).filter(Boolean),
      summary: summary || "",
      checkin: checkin || undefined,
      models: models || undefined,
      register: register || undefined,
      notes: Array.isArray(notes) ? notes : undefined
    },
    ip,
    createdAt: now,
    status: "pending" // pending | approved | rejected
  };

  subs.push(submission);
  await kv.put(SUBMISSIONS_KEY, JSON.stringify(subs));

  return json({ ok: true, message: "提交成功，等待管理员审核" }, 201, request);
}

/**
 * GET /api/admin/submissions — 查看待审核提交列表
 */
async function handleAdminGetSubmissions(kv, request) {
  const raw = await kv.get(SUBMISSIONS_KEY);
  const subs = raw ? JSON.parse(raw) : [];
  const pending = subs.filter((s) => s.status === "pending");
  return json({ ok: true, submissions: pending, total: subs.length }, 200, request);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 管理页面 HTML
// ═══════════════════════════════════════════════════════════════════════════════

function getAdminHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>sk-free 管理后台</title>
<script>
(() => {
  var k="admin-theme",c="system";
  try{c=localStorage.getItem(k)||"system"}catch{}
  var pd=window.matchMedia&&window.matchMedia("(prefers-color-scheme:dark)").matches;
  document.documentElement.dataset.theme=(c==="system"?(pd?"dark":"light"):c);
  document.documentElement.dataset.themeChoice=c;
})();
</script>
<style>
:root{--bg:#f5f5f5;--surface:#fff;--ink:#1a1a1a;--muted:#666;--line:#e0e0e0;--teal:#087f78;--teal-soft:#e6f7f5;--red:#d32f2f;--red-soft:#fdeaea;--amber:#f57c00;--amber-soft:#fff3e0;--radius:6px;--font:system-ui,-apple-system,sans-serif;--hover:#f0f0f0;--th-bg:#fafafa;--tag-bg:#eee;--shadow:0 1px 3px rgba(0,0,0,.08)}
[data-theme=dark]{--bg:#1a1d21;--surface:#23262b;--ink:#e0e0e0;--muted:#999;--line:#3a3d42;--teal:#4ecdc4;--teal-soft:#1a3a38;--red:#ef5350;--red-soft:#3a1a1a;--amber:#ffb74d;--amber-soft:#3a2a10;--hover:#2a2d32;--th-bg:#2a2d32;--tag-bg:#3a3d42;--shadow:0 1px 3px rgba(0,0,0,.3)}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--font);background:var(--bg);color:var(--ink);line-height:1.5;font-size:14px}
a{color:var(--teal);text-decoration:none}
.container{max-width:1200px;margin:0 auto;padding:16px}
/* ── 登录 ── */
.login-box{max-width:360px;margin:80px auto;padding:24px;background:var(--surface);border-radius:var(--radius);border:1px solid var(--line);text-align:center;box-shadow:var(--shadow)}
.login-box h2{margin-bottom:16px;font-size:18px}
.login-box input{width:100%;padding:10px;border:1px solid var(--line);border-radius:var(--radius);font-size:14px;margin-bottom:12px;background:var(--surface);color:var(--ink)}
.login-box button{width:100%;padding:10px;background:var(--teal);color:#fff;border:none;border-radius:var(--radius);font-size:14px;cursor:pointer;font-weight:700}
.login-box button:hover{opacity:.9}
/* ── 顶栏（固定） ── */
.header{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--line);margin-bottom:16px;position:sticky;top:0;z-index:50;background:var(--bg);backdrop-filter:blur(8px)}
.header h1{font-size:18px;flex:1}
.header .count{color:var(--muted);font-size:13px}
/* ── 主题切换按钮 ── */
.theme-toggle{display:inline-flex;gap:2px;padding:2px;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);cursor:pointer}
.theme-toggle button{padding:4px 8px;border:none;background:none;cursor:pointer;font-size:13px;border-radius:4px;color:var(--muted);transition:.15s}
.theme-toggle button.active{background:var(--teal);color:#fff}
.theme-toggle button:hover:not(.active){background:var(--hover)}
.btn{padding:6px 14px;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);cursor:pointer;font-size:13px;font-weight:600}
.btn:hover{background:var(--hover)}
.btn-primary{background:var(--teal);color:#fff;border-color:var(--teal)}
.btn-primary:hover{opacity:.9}
.btn-danger{background:var(--red);color:#fff;border-color:var(--red)}
.btn-danger:hover{opacity:.9}
.btn-sm{padding:4px 10px;font-size:12px}
/* ── 工具栏 ── */
.toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
.toolbar input[type="search"]{flex:1;min-width:200px;padding:8px 12px;border:1px solid var(--line);border-radius:var(--radius);font-size:13px}
/* ── 表格 ── */
.table-wrap{overflow-x:auto;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius)}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{padding:8px 10px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap}
th{background:var(--th-bg);font-weight:700;position:sticky;top:0}
tr:hover{background:var(--hover)}
td.name{font-weight:600;max-width:180px;overflow:hidden;text-overflow:ellipsis}
td.tags{max-width:200px}
.tag{display:inline-block;padding:2px 6px;border-radius:3px;font-size:11px;font-weight:700;background:var(--tag-bg);margin:1px}
td.summary{max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted)}
td.actions{white-space:nowrap;position:sticky;right:0;background:var(--surface);border-left:1px solid var(--line);z-index:1}
th:last-child{position:sticky;right:0;background:var(--th-bg);border-left:1px solid var(--line);z-index:2}
/* ── 启用开关 ── */
.toggle{position:relative;display:inline-block;width:36px;height:20px;cursor:pointer}
.toggle input{opacity:0;width:0;height:0}
.toggle .slider{position:absolute;inset:0;background:var(--line);border-radius:20px;transition:.3s}
.toggle .slider::before{content:"";position:absolute;left:2px;bottom:2px;width:16px;height:16px;background:#fff;border-radius:50%;transition:.3s}
.toggle input:checked+.slider{background:var(--teal)}
.toggle input:checked+.slider::before{transform:translateX(16px)}
/* ── 提交审核 ── */
.sub-card{padding:12px;border:1px solid var(--line);border-radius:var(--radius);margin-bottom:8px;background:var(--surface)}
.sub-card .sub-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.sub-card .sub-name{font-weight:700;font-size:14px}
.sub-card .sub-time{color:var(--muted);font-size:12px}
.sub-card .sub-url{color:var(--teal);font-size:12px;word-break:break-all}
.sub-card .sub-summary{color:var(--muted);font-size:13px;margin-top:4px}
.sub-card .sub-actions{margin-top:8px;display:flex;gap:6px}
.sub-empty{color:var(--muted);padding:20px;text-align:center}
/* ── 标签页 ── */
.tab-bar{display:flex;gap:0;border-bottom:2px solid var(--line);margin-bottom:16px}
.tab-btn{padding:10px 18px;border:none;background:none;cursor:pointer;font-size:14px;font-weight:600;color:var(--muted);border-bottom:2px solid transparent;margin-bottom:-2px}
.tab-btn:hover{color:var(--ink)}
.tab-btn.active{color:var(--teal);border-bottom-color:var(--teal)}
.tab-panel{display:none}
.tab-panel.active{display:block}
/* ── URL 显示 ── */
td.url-cell{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
td.url-cell .orig-url{display:block;color:var(--muted);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* ── 模态框 ── */
.modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:100;justify-content:center;align-items:center}
.modal-overlay.active{display:flex}
.modal{background:var(--surface);border-radius:var(--radius);padding:20px;width:min(560px,92vw);max-height:85vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,.2)}
.modal h3{margin-bottom:16px;font-size:16px}
.form-row{margin-bottom:12px}
.form-row label{display:block;margin-bottom:4px;font-weight:600;font-size:13px}
.form-row input,.form-row textarea,.form-row select{width:100%;padding:8px;border:1px solid var(--line);border-radius:var(--radius);font-size:13px;font-family:inherit}
.form-row textarea{min-height:60px;resize:vertical}
.form-row .hint{font-size:11px;color:var(--muted);margin-top:2px}
.form-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
/* ── 批量操作栏 ── */
.batch-bar{display:none;padding:10px 14px;background:var(--teal-soft);border-radius:var(--radius);margin-bottom:12px;align-items:center;gap:12px;font-size:13px}
.batch-bar.active{display:flex}
.batch-bar .count{font-weight:700}
/* ── Toast ── */
.toast{position:fixed;bottom:20px;right:20px;padding:12px 20px;border-radius:var(--radius);color:#fff;font-size:13px;font-weight:600;z-index:200;transform:translateY(80px);opacity:0;transition:.3s}
.toast.show{transform:translateY(0);opacity:1}
.toast.success{background:#2e7d32}
.toast.error{background:var(--red)}
/* ── 响应式 ── */
@media(max-width:768px){.toolbar{flex-direction:column}.toolbar input[type="search"]{min-width:0;width:100%}th,td{padding:6px 8px}}
</style>
</head>
<body>

<!-- ═══════ 登录页 ═══════ -->
<div id="loginView" class="container">
  <div class="login-box">
    <h2>🔐 sk-free 管理后台</h2>
    <input id="tokenInput" type="password" placeholder="输入管理密码" autofocus>
    <button onclick="doLogin()">登 录</button>
  </div>
</div>

<!-- ═══════ 管理主页 ═══════ -->
<div id="mainView" class="container" style="display:none">
  <div class="header">
    <h1>📋 站点管理</h1>
    <span class="count" id="siteCount"></span>
    <div class="theme-toggle">
      <button type="button" data-admin-theme="light" title="亮色">☀️</button>
      <button type="button" data-admin-theme="dark" title="暗色">🌙</button>
      <button type="button" data-admin-theme="system" title="跟随系统">💻</button>
    </div>
    <button class="btn" onclick="loadSites()">🔄 刷新</button>
    <button class="btn" onclick="showCreate()">➕ 新增</button>
    <button class="btn" onclick="showImport()">📥 导入</button>
    <button class="btn" onclick="exportSites()">📤 导出</button>
    <button class="btn btn-danger btn-sm" onclick="doLogout()">退出</button>
  </div>

  <div class="tab-bar">
    <button class="tab-btn active" onclick="switchTab('sites')">站点管理</button>
    <button class="tab-btn" onclick="switchTab('submissions')">提交审核 <span id="subCount" class="tag" style="display:none;background:var(--red);color:#fff"></span></button>
    <button class="tab-btn" onclick="switchTab('health')">🔗 链接健康</button>
    <button class="tab-btn" onclick="switchTab('schema')">⚙️ Schema</button>
  </div>

  <!-- ═══ 站点管理面板 ═══ -->
  <div id="panelSites" class="tab-panel active">
    <div class="toolbar">
      <input type="search" id="searchInput" placeholder="搜索站名、域名、标签..." oninput="filterTable()">
      <select id="tagFilter" onchange="filterTable()" style="padding:8px;border:1px solid var(--line);border-radius:var(--radius);font-size:13px">
        <option value="">全部标签</option>
      </select>
    </div>

    <div class="batch-bar" id="batchBar">
      <span>已选 <span class="count" id="batchCount">0</span> 项</span>
      <button class="btn btn-sm" onclick="batchTag()">🏷️ 批量打标签</button>
      <button class="btn btn-sm" onclick="batchEnable()">✅ 批量启用</button>
      <button class="btn btn-sm" onclick="batchDisable()">⛔ 批量停用</button>
      <button class="btn btn-sm btn-danger" onclick="batchDelete()">🗑️ 批量删除</button>
      <button class="btn btn-sm" onclick="clearSelection()">取消选择</button>
    </div>

    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th style="width:30px"><input type="checkbox" id="selectAll" onchange="toggleSelectAll()"></th>
            <th>启用</th>
            <th>站点名称</th>
            <th>标签</th>
            <th>签到</th>
            <th>Ref</th>
            <th>模型</th>
            <th>倍率</th>
            <th>摘要</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody id="sitesBody"></tbody>
      </table>
    </div>
  </div>

  <!-- ═══ 提交审核面板 ═══ -->
  <div id="panelSubmissions" class="tab-panel">
    <div id="submissionsList"></div>
  </div>

  <!-- ═══ 链接健康面板 ═══ -->
  <div id="panelHealth" class="tab-panel">
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
      <button class="btn btn-primary btn-sm" onclick="batchCheckUrls()">🔍 批量检查所有站点</button>
      <span id="healthStatus" style="color:var(--muted);font-size:13px"></span>
    </div>
    <div id="healthResults"></div>
    <h4 style="margin:16px 0 8px">死链接名单 <span id="deadCount" style="color:var(--muted);font-size:13px"></span></h4>
    <div id="deadUrlsList"></div>
  </div>

  <!-- ═══ Schema 管理面板 ═══ -->
  <div id="panelSchema" class="tab-panel">
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
      <button class="btn btn-primary btn-sm" onclick="loadSchema()">🔄 加载 Schema</button>
      <button class="btn btn-sm" onclick="exportSchema()">📤 导出</button>
      <button class="btn btn-sm" onclick="importSchema()">📥 导入</button>
      <span id="schemaStatus" style="color:var(--muted);font-size:13px"></span>
    </div>
    <div class="form-row">
      <label>Schema JSON（编辑后点击保存）</label>
      <textarea id="schemaEditor" rows="20" style="font-family:monospace;font-size:12px;tab-size:2" placeholder="正在加载..."></textarea>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">
      <button class="btn" onclick="loadSchema()">↩️ 重置</button>
      <button class="btn btn-primary" onclick="saveSchema()">💾 保存 Schema</button>
    </div>
    <div style="margin-top:16px;padding:12px;background:var(--teal-soft);border-radius:var(--radius);font-size:13px">
      <strong>💡 Schema 使用说明</strong>
      <ul style="margin:8px 0 0 16px;line-height:1.8">
        <li><code>fields</code>: 定义站点字段（key/label/type/required/unique/healthCheck/options/max）</li>
        <li><code>tags</code>: 全局标签选项列表</li>
        <li><code>display</code>: 前端展示配置（layout/columns/sortBy/priorityTags）</li>
        <li><code>submit</code>: 用户提交配置（enabled/rateLimit/fields）</li>
        <li><code>healthCheck</code>: URL 健康检查配置（enabled/timeout/autoBlock/blockOnImport）</li>
        <li><code>theme</code>: 主题配色（primary/accent/style）</li>
        <li>字段类型: text, url, textarea, number, tags, list, select, boolean, date, rating</li>
      </ul>
    </div>
  </div>
</div>

<!-- ═══════ 新增/编辑模态框 ═══════ -->
<div class="modal-overlay" id="editModal">
  <div class="modal">
    <h3 id="editTitle">新增站点</h3>
    <input type="hidden" id="editOriginalName">
    <div class="form-row">
      <label>站点名称 *</label>
      <input id="editName" placeholder="如：JustDoWork">
    </div>
    <div class="form-row">
      <label>URL *</label>
      <input id="editUrl" placeholder="https://...">
    </div>
    <div class="form-row">
      <label>原始 URL（导入时保留）</label>
      <input id="editOriginalUrl" placeholder="自动保留，无需手动填写">
      <div class="hint">导入时自动从 URL 剥离 aff/ref 等参数，此字段保留原始完整 URL</div>
    </div>
    <div class="form-row">
      <label>标签（逗号分隔）</label>
      <input id="editTags" placeholder="签到, 生图, 非DC">
      <div class="hint">可选：签到、生图、DC系、半DC、非DC、限免、抽奖、按次、账号、域名、交易</div>
    </div>
    <div class="form-row">
      <label>摘要</label>
      <textarea id="editSummary" placeholder="站点简要描述"></textarea>
    </div>
    <div class="form-row">
      <label>签到额度</label>
      <input id="editCheckin" placeholder="如：每日签到 5-50 刀">
    </div>
    <div class="form-row">
      <label>模型</label>
      <input id="editModels" placeholder="如：Claude Opus 5、GPT-5.6">
    </div>
    <div class="form-row">
      <label>倍率</label>
      <input id="editRate" placeholder="如：0.1">
    </div>
    <div class="form-row">
      <label>注册方式</label>
      <input id="editRegister" placeholder="如：GitHub、邮箱">
    </div>
    <div class="form-row">
      <label>邀请码 (ref)</label>
      <input id="editRef" placeholder="如：aff=FWQS 或 ref=ABC123">
      <div class="hint">导入时自动从 URL 剥离 aff/ref/invite 等推广参数存入此字段</div>
    </div>
    <div class="form-row">
      <label>备注（每行一条）</label>
      <textarea id="editNotes" placeholder="第一行备注&#10;第二行备注"></textarea>
    </div>
    <div class="form-actions">
      <button class="btn" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" onclick="saveSite()">保存</button>
    </div>
  </div>
</div>

<!-- ═══════ 导入模态框 ═══════ -->
<div class="modal-overlay" id="importModal">
  <div class="modal">
    <h3>📥 批量导入站点</h3>
    <div class="form-row">
      <label>选择 JSON 文件</label>
      <input type="file" id="importFile" accept=".json" onchange="previewImport(this)">
      <div class="hint">支持 sites.json 格式或自定义 JSON 数组，自动剥离 URL 中的 aff/ref/invite 等推广参数</div>
    </div>
    <div class="form-row" id="importPreview" style="display:none">
      <label>预览（将导入 <span id="importCount">0</span> 条）</label>
      <textarea id="importPreviewText" readonly style="min-height:120px;font-size:12px;font-family:monospace"></textarea>
    </div>
    <div class="form-row">
      <label><input type="checkbox" id="importOverwrite"> 覆盖已存在的同 URL 站点</label>
      <div class="hint">不勾选时，同 URL 站点会被跳过；勾选时会更新已有站点信息</div>
    </div>
    <div class="form-actions">
      <button class="btn" onclick="closeImportModal()">取消</button>
      <button class="btn btn-primary" id="importBtn" onclick="doImport()" disabled>开始导入</button>
    </div>
  </div>
</div>

<!-- ═══════ Toast ═══════ -->
<div class="toast" id="toast"></div>

<script>
// ── 状态 ──────────────────────────────────────────────────
let TOKEN = localStorage.getItem("sk-free-admin-token") || "";
let SITES = [];
let SELECTED = new Set();

// ── API 调用 ──────────────────────────────────────────────
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + TOKEN, ...(opts.headers || {}) }
  });
  if (res.status === 401) { doLogout(); throw new Error("登录已过期"); }
  if (path.includes("/export")) return res;
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "请求失败");
  return data;
}

// ── 主题切换 ──────────────────────────────────────────────
(function() {
  var KEY = "admin-theme";
  function applyTheme(choice) {
    var resolved = choice === "system"
      ? (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      : choice;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themeChoice = choice;
    document.querySelectorAll("[data-admin-theme]").forEach(function(btn) {
      btn.classList.toggle("active", btn.dataset.adminTheme === choice);
    });
    try { localStorage.setItem(KEY, choice); } catch {}
  }
  // 绑定按钮事件
  document.addEventListener("click", function(e) {
    var btn = e.target.closest("[data-admin-theme]");
    if (!btn) return;
    applyTheme(btn.dataset.adminTheme);
  });
  // 初始化
  var saved = "system";
  try { saved = localStorage.getItem(KEY) || "system"; } catch {}
  applyTheme(saved);
})();

// ── 认证 ──────────────────────────────────────────────────
function doLogin() {
  TOKEN = document.getElementById("tokenInput").value.trim();
  if (!TOKEN) return;
  localStorage.setItem("sk-free-admin-token", TOKEN);
  loadSites().then(() => {
    document.getElementById("loginView").style.display = "none";
    document.getElementById("mainView").style.display = "block";
  }).catch(() => {
    toast("密码错误", "error");
    TOKEN = "";
    localStorage.removeItem("sk-free-admin-token");
  });
}
function doLogout() {
  TOKEN = "";
  localStorage.removeItem("sk-free-admin-token");
  document.getElementById("loginView").style.display = "block";
  document.getElementById("mainView").style.display = "none";
}
document.getElementById("tokenInput").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });

// ── 加载站点 ──────────────────────────────────────────────
async function loadSites() {
  const data = await api("/api/admin/sites");
  SITES = data.sites || [];
  document.getElementById("siteCount").textContent = SITES.length + " 个站点";
  buildTagFilter();
  renderTable();
}

// ── 标签筛选器 ────────────────────────────────────────────
function buildTagFilter() {
  const tags = [...new Set(SITES.flatMap((s) => s.tags || []))].sort();
  const sel = document.getElementById("tagFilter");
  const current = sel.value;
  sel.innerHTML = '<option value="">全部标签</option>' + tags.map((t) => '<option value="' + esc(t) + '">' + esc(t) + '</option>').join("");
  sel.value = current;
}

// ── 表格渲染 ──────────────────────────────────────────────
function renderTable() {
  const q = document.getElementById("searchInput").value.toLowerCase();
  const tag = document.getElementById("tagFilter").value;
  const filtered = SITES.filter((s) => {
    const haystack = [s.name, s.url, s.summary, s.checkin, s.models, s.rate, ...(s.tags || [])].join(" ").toLowerCase();
    const qMatch = !q || haystack.includes(q);
    const tMatch = !tag || (s.tags || []).includes(tag);
    return qMatch && tMatch;
  });

  const tbody = document.getElementById("sitesBody");
  tbody.innerHTML = filtered.map((s) => {
    const tags = (s.tags || []).map((t) => '<span class="tag">' + esc(t) + '</span>').join("");
    const checked = SELECTED.has(s.name) ? "checked" : "";
    const enabled = s.enabled !== false;
    const toggleChecked = enabled ? "checked" : "";
    const origUrlHtml = s.originalUrl && s.originalUrl !== s.url ? '<span class="orig-url" title="' + esc(s.originalUrl) + '">原: ' + esc(s.originalUrl.slice(0, 40)) + (s.originalUrl.length > 40 ? '...' : '') + '</span>' : '';
    return '<tr>' +
      '<td><input type="checkbox" ' + checked + ' data-name="' + esc(s.name) + '" data-action="toggle-select"></td>' +
      '<td><label class="toggle"><input type="checkbox" ' + toggleChecked + ' data-name="' + esc(s.name) + '" data-action="toggle-enable"><span class="slider"></span></label></td>' +
      '<td class="name"><a href="' + esc(s.url) + '" target="_blank" title="' + esc(s.url) + '">' + esc(s.name) + '</a>' + origUrlHtml + '</td>' +
      '<td class="tags">' + tags + '</td>' +
      '<td>' + esc(s.checkin || "") + '</td>' +
      '<td title="' + esc(s.ref || "") + '">' + esc(s.ref || "") + '</td>' +
      '<td>' + esc(s.models || "") + '</td>' +
      '<td>' + esc(s.rate || "") + '</td>' +
      '<td class="summary" title="' + esc(s.summary || "") + '">' + esc(s.summary || "") + '</td>' +
      '<td class="actions">' +
        '<button class="btn btn-sm" data-name="' + esc(s.name) + '" data-action="show-edit">编辑</button> ' +
        '<button class="btn btn-sm btn-danger" data-name="' + esc(s.name) + '" data-action="delete-site">删除</button>' +
      '</td>' +
    '</tr>';
  }).join("");
}
function filterTable() { renderTable(); }
function esc(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;"); }

// ── 选择 ──────────────────────────────────────────────────
function toggleSelect(name, checked) {
  if (checked) SELECTED.add(name); else SELECTED.delete(name);
  updateBatchBar();
}
function toggleSelectAll() {
  const checked = document.getElementById("selectAll").checked;
  document.querySelectorAll("#sitesBody input[type=checkbox]").forEach((cb) => {
    cb.checked = checked;
    const name = cb.closest("tr").querySelector(".name a").textContent;
    if (checked) SELECTED.add(name); else SELECTED.delete(name);
  });
  updateBatchBar();
}
function clearSelection() {
  SELECTED.clear();
  document.getElementById("selectAll").checked = false;
  document.querySelectorAll("#sitesBody input[type=checkbox]").forEach((cb) => cb.checked = false);
  updateBatchBar();
}
function updateBatchBar() {
  const bar = document.getElementById("batchBar");
  const count = SELECTED.size;
  document.getElementById("batchCount").textContent = count;
  bar.classList.toggle("active", count > 0);
}

// ── 新增 ──────────────────────────────────────────────────
function showCreate() {
  document.getElementById("editTitle").textContent = "新增站点";
  document.getElementById("editOriginalName").value = "";
  ["editName","editUrl","editOriginalUrl","editTags","editSummary","editCheckin","editModels","editRate","editRegister","editRef","editNotes"].forEach((id) => {
    document.getElementById(id).value = "";
  });
  document.getElementById("editModal").classList.add("active");
  document.getElementById("editName").focus();
}

// ── 编辑 ──────────────────────────────────────────────────
function showEdit(name) {
  const site = SITES.find((s) => s.name === name);
  if (!site) return;
  document.getElementById("editTitle").textContent = "编辑站点：" + name;
  document.getElementById("editOriginalName").value = name;
  document.getElementById("editName").value = site.name || "";
  document.getElementById("editUrl").value = site.url || "";
  document.getElementById("editOriginalUrl").value = site.originalUrl || "";
  document.getElementById("editTags").value = (site.tags || []).join(", ");
  document.getElementById("editSummary").value = site.summary || "";
  document.getElementById("editCheckin").value = site.checkin || "";
  document.getElementById("editModels").value = site.models || "";
  document.getElementById("editRate").value = site.rate || "";
  document.getElementById("editRegister").value = site.register || "";
  document.getElementById("editRef").value = site.ref || "";
  document.getElementById("editNotes").value = (site.notes || []).join("\\n");
  document.getElementById("editModal").classList.add("active");
}

function closeModal() {
  document.getElementById("editModal").classList.remove("active");
}

// ── 保存 ──────────────────────────────────────────────────
async function saveSite() {
  const originalName = document.getElementById("editOriginalName").value;
  const tags = document.getElementById("editTags").value.split(",").map((t) => t.trim()).filter(Boolean);
  const notes = document.getElementById("editNotes").value.split("\\n").map((t) => t.trim()).filter(Boolean);
  const body = {
    name: document.getElementById("editName").value.trim(),
    url: document.getElementById("editUrl").value.trim(),
    originalUrl: document.getElementById("editOriginalUrl").value.trim() || undefined,
    tags,
    summary: document.getElementById("editSummary").value.trim(),
    checkin: document.getElementById("editCheckin").value.trim() || undefined,
    models: document.getElementById("editModels").value.trim() || undefined,
    rate: document.getElementById("editRate").value.trim() || undefined,
    register: document.getElementById("editRegister").value.trim() || undefined,
    ref: document.getElementById("editRef").value.trim() || undefined,
    notes: notes.length ? notes : undefined
  };

  if (!body.name || !body.url) { toast("名称和 URL 为必填项", "error"); return; }

  try {
    if (originalName) {
      await api("/api/admin/sites/" + encodeURIComponent(originalName), { method: "PUT", body: JSON.stringify(body) });
      toast("更新成功", "success");
    } else {
      await api("/api/admin/sites", { method: "POST", body: JSON.stringify(body) });
      toast("创建成功", "success");
    }
    closeModal();
    await loadSites();
  } catch (e) {
    toast(e.message, "error");
  }
}

// ── 删除 ──────────────────────────────────────────────────
async function deleteSite(name) {
  if (!confirm('确认删除 "' + name + '" ？')) return;
  try {
    await api("/api/admin/sites/" + encodeURIComponent(name), { method: "DELETE" });
    toast("已删除", "success");
    SELECTED.delete(name);
    await loadSites();
  } catch (e) { toast(e.message, "error"); }
}

// ── 批量操作 ──────────────────────────────────────────────
async function batchDelete() {
  if (!confirm("确认删除选中的 " + SELECTED.size + " 个站点？")) return;
  try {
    await api("/api/admin/sites/batch", { method: "POST", body: JSON.stringify({ action: "delete", names: [...SELECTED] }) });
    toast("批量删除完成", "success");
    SELECTED.clear();
    await loadSites();
  } catch (e) { toast(e.message, "error"); }
}
async function batchTag() {
  const tag = prompt("输入要添加的标签名称：");
  if (!tag) return;
  try {
    const data = await api("/api/admin/sites/batch", { method: "POST", body: JSON.stringify({ action: "add_tag", names: [...SELECTED], tag: tag.trim() }) });
    toast("已为 " + data.affected + " 个站点添加标签", "success");
    SELECTED.clear();
    await loadSites();
  } catch (e) { toast(e.message, "error"); }
}

// ── 启用/停用 ──────────────────────────────────────────
async function toggleEnable(name, enabled) {
  try {
    const site = SITES.find((s) => s.name === name);
    if (!site) return;
    await api("/api/admin/sites/" + encodeURIComponent(name), {
      method: "PUT",
      body: JSON.stringify({ ...site, enabled })
    });
    toast(enabled ? "已启用：" + name : "已停用：" + name, "success");
    await loadSites();
  } catch (e) { toast(e.message, "error"); }
}
async function batchEnable() {
  if (SELECTED.size === 0) return;
  try {
    const data = await api("/api/admin/sites/batch", { method: "POST", body: JSON.stringify({ action: "enable", names: [...SELECTED] }) });
    toast("已启用 " + data.affected + " 个站点", "success");
    SELECTED.clear();
    await loadSites();
  } catch (e) { toast(e.message, "error"); }
}
async function batchDisable() {
  if (SELECTED.size === 0) return;
  if (!confirm("确认停用选中的 " + SELECTED.size + " 个站点？")) return;
  try {
    const data = await api("/api/admin/sites/batch", { method: "POST", body: JSON.stringify({ action: "disable", names: [...SELECTED] }) });
    toast("已停用 " + data.affected + " 个站点", "success");
    SELECTED.clear();
    await loadSites();
  } catch (e) { toast(e.message, "error"); }
}

// ── 标签页切换 ──────────────────────────────────────────
function switchTab(tab) {
  document.querySelectorAll(".tab-btn").forEach((btn, i) => {
    btn.classList.toggle("active", (tab === "sites" && i === 0) || (tab === "submissions" && i === 1) || (tab === "health" && i === 2) || (tab === "schema" && i === 3));
  });
  document.getElementById("panelSites").classList.toggle("active", tab === "sites");
  document.getElementById("panelSubmissions").classList.toggle("active", tab === "submissions");
  document.getElementById("panelHealth").classList.toggle("active", tab === "health");
  document.getElementById("panelSchema").classList.toggle("active", tab === "schema");
  if (tab === "submissions") loadSubmissions();
  if (tab === "health") loadDeadUrls();
  if (tab === "schema") loadSchema();
}

// ── 提交审核 ──────────────────────────────────────────
async function loadSubmissions() {
  try {
    const data = await api("/api/admin/submissions");
    const list = document.getElementById("submissionsList");
    const countEl = document.getElementById("subCount");
    if (!data.submissions || data.submissions.length === 0) {
      list.innerHTML = '<div class="sub-empty">暂无待审核提交</div>';
      countEl.style.display = "none";
      return;
    }
    countEl.textContent = data.submissions.length;
    countEl.style.display = "inline";
    list.innerHTML = data.submissions.map((sub) => {
      const time = new Date(sub.createdAt).toLocaleString("zh-CN");
      const tags = (sub.site.tags || []).map((t) => '<span class="tag">' + esc(t) + '</span>').join(" ");
      return '<div class="sub-card" id="sub-' + sub.id + '">' +
        '<div class="sub-header"><span class="sub-name">' + esc(sub.site.name) + '</span><span class="sub-time">' + esc(time) + ' | ' + esc(sub.ip) + '</span></div>' +
        '<div class="sub-url">' + esc(sub.site.url) + '</div>' +
        (sub.site.summary ? '<div class="sub-summary">' + esc(sub.site.summary) + '</div>' : '') +
        (tags ? '<div style="margin-top:4px">' + tags + '</div>' : '') +
        '<div class="sub-actions">' +
          '<button class="btn btn-sm btn-primary" data-id="' + esc(sub.id) + '" data-action="approve-submission">✅ 批准</button>' +
          '<button class="btn btn-sm btn-danger" data-id="' + esc(sub.id) + '" data-action="reject-submission">❌ 驳回</button>' +
        '</div></div>';
    }).join("");
  } catch (e) { toast(e.message, "error"); }
}
async function approveSubmission(id) {
  try {
    const data = await api("/api/admin/submissions");
    const sub = (data.submissions || []).find((s) => s.id === id);
    if (!sub) { toast("提交不存在", "error"); return; }
    // 创建站点
    await api("/api/admin/sites", { method: "POST", body: JSON.stringify(sub.site) });
    // 标记为已批准
    await api("/api/admin/sites/batch", { method: "POST", body: JSON.stringify({ action: "approve_submission", id }) });
    toast("已批准并添加站点", "success");
    await loadSubmissions();
    await loadSites();
  } catch (e) { toast(e.message, "error"); }
}
async function rejectSubmission(id) {
  if (!confirm("确认驳回此提交？")) return;
  try {
    await api("/api/admin/sites/batch", { method: "POST", body: JSON.stringify({ action: "reject_submission", id }) });
    toast("已驳回", "success");
    await loadSubmissions();
  } catch (e) { toast(e.message, "error"); }
}

// ── 链接健康检查 ──────────────────────────────────────────
async function loadDeadUrls() {
  try {
    const data = await api("/api/admin/dead-urls");
    const list = document.getElementById("deadUrlsList");
    const countEl = document.getElementById("deadCount");
    const urls = Object.keys(data.deadUrls || {});
    countEl.textContent = urls.length > 0 ? ("(" + urls.length + " 个)") : "(空)";
    if (urls.length === 0) {
      list.innerHTML = '<div style="color:var(--muted);padding:12px">暂无死链接</div>';
      return;
    }
    list.innerHTML = urls.map(url => {
      const info = data.deadUrls[url];
      const time = info.addedAt ? new Date(info.addedAt).toLocaleString() : "";
      const reason = info.error || info.reason || "";
      return '<div style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-bottom:1px solid var(--line);font-size:13px">' +
        '<span style="flex:1;word-break:break-all;color:var(--coral)">' + esc(url) + '</span>' +
        '<span style="color:var(--muted);font-size:11px;white-space:nowrap">' + esc(reason) + ' ' + time + '</span>' +
        '<button class="btn btn-sm btn-danger" data-url="' + esc(url) + '" data-action="remove-dead">移除</button>' +
      '</div>';
    }).join("");
  } catch (e) { toast("加载死链接失败: " + e.message, "error"); }
}

async function removeDeadUrl(url) {
  try {
    await api("/api/admin/dead-urls", { method: "POST", body: JSON.stringify({ url, action: "remove" }) });
    toast("已移除");
    await loadDeadUrls();
  } catch (e) { toast(e.message, "error"); }
}

async function batchCheckUrls() {
  const statusEl = document.getElementById("healthStatus");
  const resultsEl = document.getElementById("healthResults");
  statusEl.textContent = "正在检查中，请稍候...";
  resultsEl.innerHTML = "";
  try {
    const data = await api("/api/admin/check-batch", { method: "POST", body: JSON.stringify({}) });
    var statusMsg = "检查完成：共 " + data.total + " 个，" + data.alive + " 个正常，" + data.dead + " 个不可达";
    if (data.newDead > 0) statusMsg += "（新增 " + data.newDead + " 个死链接）";
    if (data.truncated) statusMsg += "（因超时跳过 " + (data.totalAvailable - data.checked) + " 个）";
    statusEl.textContent = statusMsg;
    // 按状态分组显示
    const dead = data.results.filter(r => !r.ok);
    const alive = data.results.filter(r => r.ok);
    let html = "";
    if (dead.length > 0) {
      html += '<div style="margin-bottom:12px"><strong style="color:var(--coral)">❌ 不可达 (' + dead.length + ')</strong></div>';
      html += dead.map(r => {
        const detail = r.error || ("HTTP " + r.status);
        return '<div style="display:flex;align-items:center;gap:8px;padding:4px 8px;font-size:12px;border-bottom:1px solid var(--line)">' +
          '<span style="flex:1;word-break:break-all">' + esc(r.url) + '</span>' +
          '<span style="color:var(--coral);white-space:nowrap">' + esc(detail) + '</span>' +
        '</div>';
      }).join("");
    }
    if (alive.length > 0) {
      html += '<div style="margin:12px 0 8px"><strong style="color:var(--teal)">✅ 正常 (' + alive.length + ')</strong></div>';
      html += alive.map(r => {
        return '<div style="display:flex;align-items:center;gap:8px;padding:4px 8px;font-size:12px;border-bottom:1px solid var(--line)">' +
          '<span style="flex:1;word-break:break-all">' + esc(r.url) + '</span>' +
          '<span style="color:var(--teal);white-space:nowrap">HTTP ' + r.status + '</span>' +
        '</div>';
      }).join("");
    }
    resultsEl.innerHTML = html;
    await loadDeadUrls(); // 刷新死链接列表
  } catch (e) {
    statusEl.textContent = "检查失败: " + e.message;
  }
}

// ── Schema 管理 ──────────────────────────────────────────
async function loadSchema() {
  try {
    const data = await api("/api/admin/schema");
    document.getElementById("schemaEditor").value = JSON.stringify(data.schema, null, 2);
    document.getElementById("schemaStatus").textContent = "已加载";
  } catch (e) {
    document.getElementById("schemaStatus").textContent = "加载失败: " + e.message;
  }
}

async function saveSchema() {
  const editor = document.getElementById("schemaEditor");
  let schema;
  try {
    schema = JSON.parse(editor.value);
  } catch (e) {
    toast("JSON 格式错误: " + e.message, "error");
    return;
  }
  try {
    const data = await api("/api/admin/schema", { method: "PUT", body: JSON.stringify(schema) });
    editor.value = JSON.stringify(data.schema, null, 2);
    document.getElementById("schemaStatus").textContent = "保存成功";
    toast("Schema 已保存", "success");
  } catch (e) {
    toast("保存失败: " + e.message, "error");
  }
}

function exportSchema() {
  const editor = document.getElementById("schemaEditor");
  const text = editor.value;
  if (!text) { toast("没有 Schema 数据", "error"); return; }
  var blob = new Blob([text], { type: "application/json" });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url; a.download = "schema.json"; a.click();
  URL.revokeObjectURL(url);
}

function importSchema() {
  var input = document.createElement("input");
  input.type = "file"; input.accept = ".json";
  input.onchange = function(e) {
    var file = e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function(ev) {
      document.getElementById("schemaEditor").value = ev.target.result;
      document.getElementById("schemaStatus").textContent = "已导入（未保存）";
      toast("Schema 已导入，请检查后点击保存", "success");
    };
    reader.readAsText(file);
  };
  input.click();
}

// ── 导出 ──────────────────────────────────────────────────
function exportSites() {
  fetch("/api/admin/export", {
    headers: { "Authorization": "Bearer " + TOKEN }
  }).then(function(res) {
    if (!res.ok) { toast("导出失败: " + res.status, "error"); return; }
    return res.text();
  }).then(function(text) {
    if (!text) return;
    var blob = new Blob([text], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = "sites-export.json"; a.click();
    URL.revokeObjectURL(url);
    toast("导出成功");
  }).catch(function() { toast("网络错误", "error"); });
}

// ── 导入 ──────────────────────────────────────────────────
let IMPORT_DATA = null;
function showImport() {
  IMPORT_DATA = null;
  document.getElementById("importFile").value = "";
  document.getElementById("importPreview").style.display = "none";
  document.getElementById("importBtn").disabled = true;
  document.getElementById("importOverwrite").checked = false;
  document.getElementById("importModal").classList.add("active");
}
function closeImportModal() {
  document.getElementById("importModal").classList.remove("active");
  IMPORT_DATA = null;
}
function previewImport(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const raw = JSON.parse(e.target.result);
      // 支持两种格式：{ sites: [...] } 或 [...]
      let sites = Array.isArray(raw) ? raw : (raw.sites || []);
      // 简单验证
      sites = sites.filter((s) => s && s.name && s.url);
      if (sites.length === 0) { toast("未找到有效站点数据", "error"); return; }
      IMPORT_DATA = sites;
      document.getElementById("importCount").textContent = sites.length;
      const preview = sites.slice(0, 10).map((s) => {
        let line = "• " + s.name;
        if (s.url) line += " → " + s.url.slice(0, 50) + (s.url.length > 50 ? "..." : "");
        return line;
      }).join("\\n");
      document.getElementById("importPreviewText").value = preview + (sites.length > 10 ? "\\n... 共 " + sites.length + " 条" : "");
      document.getElementById("importPreview").style.display = "block";
      document.getElementById("importBtn").disabled = false;
    } catch (err) {
      toast("JSON 解析失败: " + err.message, "error");
    }
  };
  reader.readAsText(file);
}
async function doImport() {
  if (!IMPORT_DATA || IMPORT_DATA.length === 0) { toast("无数据可导入", "error"); return; }
  const overwrite = document.getElementById("importOverwrite").checked;
  document.getElementById("importBtn").disabled = true;
  try {
    const data = await api("/api/admin/sites/import", {
      method: "POST",
      body: JSON.stringify({ sites: IMPORT_DATA, overwrite })
    });
    let msg = "导入完成：新增 " + data.added + " 条";
    if (data.updated) msg += "，更新 " + data.updated + " 条";
    if (data.skipped) msg += "，跳过 " + data.skipped + " 条";
    if (data.duplicates && data.duplicates.length > 0) {
      msg += "\\n重复站点：" + data.duplicates.map((d) => d.existingName).join(", ");
    }
    toast(msg, "success");
    closeImportModal();
    await loadSites();
  } catch (e) {
    toast(e.message, "error");
    document.getElementById("importBtn").disabled = false;
  }
}

// ── Toast ─────────────────────────────────────────────────
function toast(msg, type) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = "toast " + type + " show";
  setTimeout(() => el.classList.remove("show"), 3000);
}

// ── 初始化 ────────────────────────────────────────────────
if (TOKEN) {
  loadSites().then(() => {
    document.getElementById("loginView").style.display = "none";
    document.getElementById("mainView").style.display = "block";
  }).catch(() => {
    TOKEN = "";
    localStorage.removeItem("sk-free-admin-token");
  });
}

// ── 事件委托 ──────────────────────────────────────────────
// 所有动态生成的按钮通过 data-action 属性路由点击事件
// 避免模板字面量中内联 onclick 的多层转义问题
document.addEventListener("click", function(e) {
  var el = e.target.closest("[data-action]");
  if (!el) return;
  var action = el.getAttribute("data-action");
  var name = el.getAttribute("data-name") || "";
  var id = el.getAttribute("data-id") || "";
  switch (action) {
    case "toggle-select":    toggleSelect(name, el.checked); break;
    case "toggle-enable":    toggleEnable(name, el.checked); break;
    case "show-edit":        showEdit(name); break;
    case "delete-site":      deleteSite(name); break;
    case "approve-submission": approveSubmission(id); break;
    case "reject-submission":  rejectSubmission(id); break;
    case "remove-dead":       removeDeadUrl(el.getAttribute("data-url")); break;
  }
});
document.addEventListener("change", function(e) {
  var el = e.target.closest("[data-action]");
  if (!el) return;
  var action = el.getAttribute("data-action");
  var name = el.getAttribute("data-name") || "";
  if (action === "toggle-select") toggleSelect(name, el.checked);
  if (action === "toggle-enable") toggleEnable(name, el.checked);
});
</script>
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Worker 入口
// ═══════════════════════════════════════════════════════════════════════════════

export default {
  async fetch(request, env) {
    try {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS 预检
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    const kv = env.SKFREE_KV;

    // ── 管理页面 ───────────────────────────────────────────
    if (path === "/admin" && request.method === "GET") {
      return html(getAdminHTML());
    }

    // ── 管理 API（需认证）──────────────────────────────────
    if (path.startsWith("/api/admin")) {
      const authError = requireAuth(request, env);
      if (authError) return authError;

      // 管理 API 速率限制（基于 IP 滑动窗口）
      cleanupAdminRateMap();
      const rateLimit = checkAdminRateLimit(request);
      if (rateLimit) {
        return json({ ok: false, error: `管理 API 请求过于频繁，请 ${rateLimit.retryAfter} 秒后再试` }, 429, request);
      }

      // POST /api/admin/sites/import — 批量导入（智能解析 URL）
      if (path === "/api/admin/sites/import" && request.method === "POST") {
        return handleAdminImportSites(kv, request);
      }

      // GET /api/admin/sites
      if (path === "/api/admin/sites" && request.method === "GET") {
        return handleAdminListSites(kv, request);
      }
      // POST /api/admin/sites
      if (path === "/api/admin/sites" && request.method === "POST") {
        return handleAdminCreateSite(kv, request);
      }
      // POST /api/admin/sites/batch
      if (path === "/api/admin/sites/batch" && request.method === "POST") {
        const batchBody = await request.clone().json().catch(() => ({}));
        if (batchBody.action === "approve_submission" || batchBody.action === "reject_submission") {
          return handleAdminSubmissionAction(kv, request, batchBody.action, batchBody.id);
        }
        return handleAdminBatch(kv, request);
      }
      // GET /api/admin/export
      if (path === "/api/admin/export" && request.method === "GET") {
        return handleAdminExport(kv, request);
      }
      // GET /api/admin/submissions — 查看待审核提交
      if (path === "/api/admin/submissions" && request.method === "GET") {
        return handleAdminGetSubmissions(kv, request);
      }
      // PUT /api/admin/sites/:name
      const putMatch = path.match(/^\/api\/admin\/sites\/(.+)$/);
      if (putMatch && request.method === "PUT") {
        return handleAdminUpdateSite(kv, request, decodeURIComponent(putMatch[1]));
      }
      // DELETE /api/admin/sites/:name
      if (putMatch && request.method === "DELETE") {
        return handleAdminDeleteSite(kv, request, decodeURIComponent(putMatch[1]));
      }

      // GET /api/admin/dead-urls — 获取死链接列表
      if (path === "/api/admin/dead-urls" && request.method === "GET") {
        const deadUrls = await getDeadUrls(kv);
        return json({ ok: true, deadUrls }, 200, request);
      }
      // POST /api/admin/dead-urls — 添加/移除死链接
      // body: { url, action: "add" | "remove" }
      if (path === "/api/admin/dead-urls" && request.method === "POST") {
        const parsed = await parseJsonBody(request);
        if (!parsed.ok) return parsed.response;
        const { url, action } = parsed.data;
        if (!url || !action) return json({ ok: false, error: "需要 url 和 action 参数" }, 400, request);
        const deadUrls = await getDeadUrls(kv);
        if (action === "add") {
          deadUrls[url] = { addedAt: Date.now(), reason: "unreachable" };
        } else if (action === "remove") {
          delete deadUrls[url];
        } else {
          return json({ ok: false, error: "action 只能是 add 或 remove" }, 400, request);
        }
        await saveDeadUrls(kv, deadUrls);
        return json({ ok: true, count: Object.keys(deadUrls).length }, 200, request);
      }

      // POST /api/admin/check-url — 检查单个 URL
      // body: { url }
      if (path === "/api/admin/check-url" && request.method === "POST") {
        const parsed = await parseJsonBody(request);
        if (!parsed.ok) return parsed.response;
        const { url } = parsed.data;
        if (!url) return json({ ok: false, error: "需要 url 参数" }, 400, request);
        const result = await checkUrlHealth(url);
        return json({ ok: true, url, ...result }, 200, request);
      }

      // POST /api/admin/check-batch — 批量检查所有站点 URL
      // body: { urls?: string[] }（不传则检查所有站点）
      if (path === "/api/admin/check-batch" && request.method === "POST") {
        const parsed = await parseJsonBody(request);
        if (!parsed.ok) return parsed.response;
        let urls = parsed.data.urls;
        if (!urls || !Array.isArray(urls)) {
          // 默认检查所有站点
          const sitesData = await handleGetSites(kv);
          urls = (sitesData.sites || []).map(s => s.url).filter(Boolean);
        }

        // 全局超时保护：25s（Workers 总限制 30s，留 5s 余量给 KV 写入）
        const GLOBAL_TIMEOUT_MS = 25000;
        const PER_URL_TIMEOUT_MS = 3000;
        const BATCH_SIZE = 20;
        const globalStart = Date.now();
        const results = [];
        let timedOut = false;

        for (let i = 0; i < urls.length; i += BATCH_SIZE) {
          if (Date.now() - globalStart > GLOBAL_TIMEOUT_MS) {
            timedOut = true;
            break;
          }
          const batch = urls.slice(i, i + BATCH_SIZE);
          const batchResults = await Promise.all(batch.map(async (url) => {
            const r = await checkUrlHealth(url, PER_URL_TIMEOUT_MS);
            return { url, ...r };
          }));
          results.push(...batchResults);
        }

        // 自动将不可达的 URL 加入死链接列表
        const deadUrls = await getDeadUrls(kv);
        let newDead = 0;
        for (const r of results) {
          if (!r.ok && !deadUrls[r.url]) {
            deadUrls[r.url] = { addedAt: Date.now(), status: r.status, error: r.error, reason: "auto-detected" };
            newDead++;
          }
        }
        if (newDead > 0) await saveDeadUrls(kv, deadUrls);
        const alive = results.filter(r => r.ok).length;
        const dead = results.filter(r => !r.ok).length;
        return json({
          ok: true, total: results.length, alive, dead, newDead, results,
          ...(timedOut ? { truncated: true, checked: results.length, totalAvailable: urls.length, message: "部分检查因超时跳过" } : {})
        }, 200, request);
      }

      // GET /api/admin/schema — 获取完整 Schema（含默认值）
      if (path === "/api/admin/schema" && request.method === "GET") {
        const schema = await getSchema(kv);
        return json({ ok: true, schema }, 200, request);
      }

      // PUT /api/admin/schema — 更新 Schema（全量替换）
      if (path === "/api/admin/schema" && request.method === "PUT") {
        const parsed = await parseJsonBody(request);
        if (!parsed.ok) return parsed.response;
        const newSchema = parsed.data;
        // 基础校验：必须有 fields 数组
        if (!newSchema.fields || !Array.isArray(newSchema.fields)) {
          return json({ ok: false, error: "schema 必须包含 fields 数组" }, 400, request);
        }
        // 校验每个 field 的 key 和 type
        for (const f of newSchema.fields) {
          if (!f.key || !f.label || !f.type) {
            return json({ ok: false, error: `字段缺少必填属性 (key/label/type): ${JSON.stringify(f)}` }, 400, request);
          }
          const validTypes = ["text", "url", "textarea", "number", "tags", "list", "select", "boolean", "date", "rating"];
          if (!validTypes.includes(f.type)) {
            return json({ ok: false, error: `字段类型无效: ${f.type}，支持: ${validTypes.join(", ")}` }, 400, request);
          }
        }
        // 合并默认值
        const merged = {
          ...DEFAULT_SCHEMA,
          ...newSchema,
          fields: newSchema.fields,
          tags: newSchema.tags || DEFAULT_SCHEMA.tags,
          display: { ...DEFAULT_SCHEMA.display, ...(newSchema.display || {}) },
          submit: { ...DEFAULT_SCHEMA.submit, ...(newSchema.submit || {}) },
          healthCheck: { ...DEFAULT_SCHEMA.healthCheck, ...(newSchema.healthCheck || {}) },
          theme: { ...DEFAULT_SCHEMA.theme, ...(newSchema.theme || {}) }
        };
        await saveSchema(kv, merged);
        return json({ ok: true, schema: merged }, 200, request);
      }

      return json({ ok: false, error: "Not Found" }, 404, request);
    }

    // ── 公开 API ───────────────────────────────────────────

    // GET /api/schema — 获取当前平台的 Schema 配置（前端动态渲染用）
    if (path === "/api/schema" && request.method === "GET") {
      const schema = await getSchema(kv);
      return json({ ok: true, schema }, 200, request);
    }

    // GET /api/sites — 站点列表（前端渲染用，仅返回已启用站点）
    if (path === "/api/sites" && request.method === "GET") {
      const data = await handleGetEnabledSites(kv);
      return json(data, 200, request);
    }

    // POST /api/submit — 用户提交新站点
    if (path === "/api/submit" && request.method === "POST") {
      return handleSubmitSite(request, kv);
    }

    // GET /api/votes
    if (path === "/api/votes" && request.method === "GET") {
      return handleGetVotes(kv, request);
    }

    // POST /api/vote
    if (path === "/api/vote" && request.method === "POST") {
      return handleVote(request, kv);
    }

    // GET /api/health
    if (path === "/api/health") {
      return json({ ok: true, timestamp: Date.now() }, 200, request);
    }

    // 404
    return json({ ok: false, error: "Not Found" }, 404, request);

    } catch (e) {
      return json({ ok: false, error: "Internal error: " + e.message }, 500, request);
    }
  }
};
