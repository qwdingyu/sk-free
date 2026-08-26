// ═══════════════════════════════════════════════════════════════════════════════
// sites.js — 站点 CRUD + 导入导出（D1 版本）
// 从 KV 全量 JSON 重写迁移到 D1 单行 INSERT/UPDATE/DELETE
// ═══════════════════════════════════════════════════════════════════════════════

import { dbAll, dbGet, dbRun, dbBatch } from "./db.js";
import { getDeadUrls } from "./deadurls.js";
import { json as jsonResponse, parseJsonBody, validateUrlProtocol, parseSiteUrl } from "./utils.js";

// 导入限制
const IMPORT_MAX_BATCH = 500;

// ─── 0003 结构化字段的合法取值 ─────────────────────────────────────────────────
// 这些枚举是排序和筛选的基础：写进一个非法值不会报错，但会让该条数据
// 在"额度档位"筛选里永远匹配不到，属于静默失效。所以在写入口一律校验。
export const SITE_KINDS = ["api_site", "bot", "account_pool", "tool"];
export const QUOTA_UNITS = ["usd", "cny", "credit", "coin", "token", "call"];
export const QUOTA_PERIODS = ["daily", "weekly", "once", "none"];
export const QUOTA_TIERS = ["high", "mid", "low", "none"];
// 跨单位没有汇率（刀/元/积分/硬币互不可换算），排序只依据人工判定的 tier
export const TIER_ORDER = { high: 3, mid: 2, low: 1, none: 0 };

/** 空串和 undefined 一律归一成 null —— NULL 表示"未知"，空串会污染筛选 */
function strOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/** 数值字段：非法输入归 null 而不是 NaN（NaN 进 D1 会变成怪值） */
function numOrNull(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function intOrNull(v) {
  const n = numOrNull(v);
  return n === null ? null : Math.trunc(n);
}

/** needs_proxy 是三态：1 需要 / 0 不需要 / NULL 未知。不确定时必须是 NULL */
function boolIntOrNull(v) {
  if (v === undefined || v === null || v === "") return null;
  if (v === true || v === 1 || v === "1" || v === "true") return 1;
  if (v === false || v === 0 || v === "0" || v === "false") return 0;
  return null;
}

/**
 * 校验结构化字段的枚举取值与数值区间
 * @param {object} s — 含 kind、quota 系列、needsProxy 的对象（camelCase）
 * @returns {{ ok: boolean, error?: string }}
 */
function validateStructuredFields(s) {
  const enums = [
    ["kind", s.kind, SITE_KINDS],
    ["quotaUnit", s.quotaUnit, QUOTA_UNITS],
    ["quotaPeriod", s.quotaPeriod, QUOTA_PERIODS],
    ["quotaTier", s.quotaTier, QUOTA_TIERS],
  ];
  for (const [name, raw, allowed] of enums) {
    const v = strOrNull(raw);
    if (v !== null && !allowed.includes(v)) {
      return { ok: false, error: `${name} 只能是 ${allowed.join(" / ")}，收到 "${v}"` };
    }
  }

  const min = numOrNull(s.quotaMin);
  const max = numOrNull(s.quotaMax);
  if (min !== null && min < 0) return { ok: false, error: "quotaMin 不能为负" };
  if (max !== null && max < 0) return { ok: false, error: "quotaMax 不能为负" };
  if (min !== null && max !== null && min > max) {
    return { ok: false, error: `quotaMin(${min}) 不能大于 quotaMax(${max})` };
  }

  const calls = numOrNull(s.quotaCallsEst);
  if (calls !== null && calls < 0) return { ok: false, error: "quotaCallsEst 不能为负" };

  const slug = strOrNull(s.slug);
  if (slug !== null && !/^[a-z0-9][a-z0-9-]{0,39}$/.test(slug)) {
    return { ok: false, error: "slug 只能是小写字母、数字和连字符，1~40 字符，且不以连字符开头" };
  }

  return { ok: true };
}

/**
 * 格式化单个站点行为前端期望的格式
 * @param {object} row — D1 查询结果行
 * @returns {object} 格式化后的站点对象
 */
function formatSiteRow(row) {
  return {
    name: row.name,
    url: row.url,
    tags: row.tags ? JSON.parse(row.tags) : [],
    summary: row.summary || "",
    checkin: row.checkin || "",
    models: row.models || "",
    rate: row.rate || "",
    register: row.register || "",
    notes: row.notes ? JSON.parse(row.notes) : [],
    ref: row.ref || "",
    originalUrl: row.original_url || "",
    enabled: row.enabled === 1,
    sortOrder: row.sort_order || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // 0003 新增结构化字段（nullable，NULL 表示未知）
    slug: row.slug || null,
    kind: row.kind || "api_site",
    quotaMin: row.quota_min ?? null,
    quotaMax: row.quota_max ?? null,
    quotaUnit: row.quota_unit || null,
    quotaPeriod: row.quota_period || null,
    quotaCallsEst: row.quota_calls_est ?? null,
    quotaTier: row.quota_tier || null,
    quotaRaw: row.quota_raw || null,
    needsProxy: row.needs_proxy ?? null,
    verifiedAt: row.verified_at || null,
    verifiedBy: row.verified_by || null,
    healthFailCount: row.health_fail_count ?? 0,
  };
}

// ─── 公开 API ─────────────────────────────────────────────────────────────────

/**
 * 获取所有站点（管理端，含禁用站点）+ 投票数据
 * @param {object} db — D1 数据库实例
 * @returns {Promise<object>} { ok, sites, metadata }
 */
export async function handleGetSites(db) {
  const sites = await dbAll(db, "SELECT * FROM sites ORDER BY sort_order ASC, name ASC");
  const votes = await dbAll(db, "SELECT site_name, up_count, down_count FROM votes");
  // 死链 URL 集合：给管理端站点列表打"死链"标记，便于管理员识别
  const deadUrlRows = await dbAll(db, "SELECT url FROM dead_urls");

  const voteMap = {};
  for (const v of votes) {
    voteMap[v.site_name] = { up: v.up_count, down: v.down_count };
  }
  const deadUrlSet = new Set(deadUrlRows.map((r) => r.url));

  return {
    ok: true,
    sites: sites.map((s) => ({
      ...formatSiteRow(s),
      votes: voteMap[s.name] || { up: 0, down: 0 },
      dead: deadUrlSet.has(s.url),
    })),
    metadata: {
      total: sites.length,
      enabled: sites.filter((s) => s.enabled === 1).length,
      disabled: sites.filter((s) => s.enabled !== 1).length,
      updatedAt: new Date().toISOString(),
    },
  };
}

/**
 * 获取已启用站点（公开 API，前端渲染用）
 * @param {object} db — D1 数据库实例
 * @returns {Promise<object>} { ok, sites }
 */
export async function handleGetEnabledSites(db) {
  // 查询启用站点 + 死链接黑名单 + 投票数据（3 次并行查询）
  // 死链标记为 dead:true，由前端决定展示策略（折叠/降饱和），不直接过滤
  const [sites, votes, deadUrlRows] = await Promise.all([
    dbAll(db, "SELECT * FROM sites WHERE enabled = 1 ORDER BY sort_order ASC, name ASC"),
    dbAll(db, "SELECT site_name, up_count, down_count FROM votes"),
    dbAll(db, "SELECT url FROM dead_urls"),
  ]);

  const voteMap = {};
  for (const v of votes) {
    voteMap[v.site_name] = { up: v.up_count, down: v.down_count };
  }
  const deadUrlSet = new Set(deadUrlRows.map((r) => r.url));

  const enabledCount = sites.length;
  const deadCount = sites.filter((s) => deadUrlSet.has(s.url)).length;

  return {
    ok: true,
    sites: sites.map((s) => ({
      ...formatSiteRow(s),
      votes: voteMap[s.name] || { up: 0, down: 0 },
      dead: deadUrlSet.has(s.url),
    })),
    metadata: {
      total: enabledCount,
      enabled: enabledCount - deadCount,
      dead: deadCount,
      updatedAt: new Date().toISOString(),
    },
  };
}

/**
 * 管理端：获取站点列表（含完整统计）
 * @param {object} db — D1 数据库实例
 * @param {object} request — Fetch Request
 * @returns {Promise<Response>} JSON 响应
 */
export async function handleAdminListSites(db, request) {
  const data = await handleGetSites(db);
  return jsonResponse(data, 200, request);
}

/**
 * 新增站点
 * @param {object} db — D1 数据库实例
 * @param {object} request — Fetch Request
 * @param {object} kv — KV 命名空间绑定（用于读取 Schema）
 * @returns {Promise<Response>}
 */
export async function handleAdminCreateSite(db, request, kv) {
  const parsed = await parseJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  if (!body.name) {
    return jsonResponse({ ok: false, error: "站点名称为必填项" }, 400, request);
  }

  // 检查名称唯一性
  const existing = await dbGet(db, "SELECT name FROM sites WHERE name = ?", [body.name]);
  if (existing) {
    return jsonResponse({ ok: false, error: `站点 "${body.name}" 已存在` }, 409, request);
  }

  // URL 协议校验
  if (body.url) {
    const urlCheck = validateUrlProtocol(body.url);
    if (!urlCheck.ok) {
      return jsonResponse({ ok: false, error: urlCheck.error }, 400, request);
    }
  }

  // URL 清理：剥离推广参数（ref/aff/invite），与导入流程一致
  const { originalUrl, cleanUrl, ref } = parseSiteUrl(body.url);

  const tags = Array.isArray(body.tags) ? body.tags : [];
  const notes = Array.isArray(body.notes) ? body.notes : [];

  // 联动：URL 已在死链接黑名单中 → 新建站点默认禁用（保持用户端/管理端状态一致）
  let enabled = body.enabled !== false ? 1 : 0;
  if (cleanUrl) {
    const deadRow = await dbGet(db, "SELECT url FROM dead_urls WHERE url = ?", [cleanUrl]);
    if (deadRow) enabled = 0;
  }

  // 结构化字段校验（与更新路径同一套规则）
  const structCheck = validateStructuredFields(body);
  if (!structCheck.ok) {
    return jsonResponse({ ok: false, error: structCheck.error }, 400, request);
  }

  // slug 唯一性：不给就留 NULL（UNIQUE 索引允许多个 NULL），不自动编造
  const slug = strOrNull(body.slug);
  if (slug) {
    const dupSlug = await dbGet(db, "SELECT name FROM sites WHERE slug = ?", [slug]);
    if (dupSlug) {
      return jsonResponse({ ok: false, error: `slug "${slug}" 已被 "${dupSlug.name}" 占用` }, 409, request);
    }
  }

  // quota_raw 缺省用 checkin 原文兜底 —— 原始信息永不丢失
  const quotaRaw = strOrNull(body.quotaRaw) ?? strOrNull(body.checkin);

  await dbRun(
    db,
    `INSERT INTO sites (name, url, original_url, ref, tags, summary, enabled, checkin, models, rate, register, notes, sort_order,
                        slug, kind, quota_min, quota_max, quota_unit, quota_period, quota_calls_est, quota_tier, quota_raw,
                        needs_proxy, verified_at, verified_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    [
      body.name,
      cleanUrl || "",
      originalUrl || "",
      ref || body.ref || "",
      JSON.stringify(tags),
      body.summary || "",
      enabled,
      body.checkin || "",
      body.models || "",
      body.rate || "",
      body.register || "",
      JSON.stringify(notes),
      body.sortOrder || 0,
      slug,
      strOrNull(body.kind) ?? "api_site",
      numOrNull(body.quotaMin),
      numOrNull(body.quotaMax),
      strOrNull(body.quotaUnit),
      strOrNull(body.quotaPeriod) ?? "none",
      intOrNull(body.quotaCallsEst),
      strOrNull(body.quotaTier) ?? "none",
      quotaRaw,
      boolIntOrNull(body.needsProxy),
      strOrNull(body.verifiedAt),
      strOrNull(body.verifiedBy),
    ]
  );

  return jsonResponse({ ok: true, message: `站点 "${body.name}" 已创建` }, 201, request);
}

/**
 * 更新站点（合并更新，保留未提供的字段）
 * @param {object} db — D1 数据库实例
 * @param {object} request — Fetch Request
 * @param {string} siteName — 要更新的站点名称（URL 解码后）
 * @returns {Promise<Response>}
 */
export async function handleAdminUpdateSite(db, request, siteName) {
  // 检查站点是否存在
  const existing = await dbGet(db, "SELECT * FROM sites WHERE name = ?", [siteName]);
  if (!existing) {
    return jsonResponse({ ok: false, error: `站点 "${siteName}" 不存在` }, 404, request);
  }

  const parsed = await parseJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  // 如果修改了名称，检查新名称唯一性
  if (body.name && body.name !== siteName) {
    const dup = await dbGet(db, "SELECT name FROM sites WHERE name = ?", [body.name]);
    if (dup) {
      return jsonResponse({ ok: false, error: `站点 "${body.name}" 已存在` }, 409, request);
    }
  }

  // URL 协议校验
  if (body.url) {
    const urlCheck = validateUrlProtocol(body.url);
    if (!urlCheck.ok) {
      return jsonResponse({ ok: false, error: urlCheck.error }, 400, request);
    }
  }

  // 合并语义说明：
  //  - 传统文本字段用 ?? —— 不传就保留原值
  //  - 结构化字段用 pick() —— body 里"出现过这个键"才覆盖，
  //    这样才能把字段显式改回 null（未知）。用 ?? 会导致"未知"永远设不回去。
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  const pick = (k, dbVal) => (has(k) ? body[k] : dbVal);

  const updated = {
    name: body.name ?? existing.name,
    url: body.url ?? existing.url,
    tags: body.tags ?? (existing.tags ? JSON.parse(existing.tags) : []),
    summary: body.summary ?? existing.summary,
    checkin: body.checkin ?? existing.checkin,
    models: body.models ?? existing.models,
    rate: body.rate ?? existing.rate,
    register: body.register ?? existing.register,
    notes: body.notes ?? (existing.notes ? JSON.parse(existing.notes) : []),
    ref: body.ref ?? existing.ref,
    originalUrl: body.originalUrl ?? existing.original_url,
    enabled: body.enabled !== undefined ? body.enabled : existing.enabled === 1,
    sortOrder: body.sortOrder ?? existing.sort_order,
    // ── 0003 结构化字段 ──
    slug: pick("slug", existing.slug),
    kind: pick("kind", existing.kind),
    quotaMin: pick("quotaMin", existing.quota_min),
    quotaMax: pick("quotaMax", existing.quota_max),
    quotaUnit: pick("quotaUnit", existing.quota_unit),
    quotaPeriod: pick("quotaPeriod", existing.quota_period),
    quotaCallsEst: pick("quotaCallsEst", existing.quota_calls_est),
    quotaTier: pick("quotaTier", existing.quota_tier),
    quotaRaw: pick("quotaRaw", existing.quota_raw),
    needsProxy: pick("needsProxy", existing.needs_proxy),
    verifiedAt: pick("verifiedAt", existing.verified_at),
    verifiedBy: pick("verifiedBy", existing.verified_by),
  };

  // 结构化字段校验：枚举值写错会静默破坏排序和筛选，必须在入口拦住
  const structCheck = validateStructuredFields(updated);
  if (!structCheck.ok) {
    return jsonResponse({ ok: false, error: structCheck.error }, 400, request);
  }

  // slug 唯一性（UNIQUE 索引允许多个 NULL，所以只在显式给值时检查）
  if (updated.slug && updated.slug !== existing.slug) {
    const dupSlug = await dbGet(db, "SELECT name FROM sites WHERE slug = ?", [updated.slug]);
    if (dupSlug) {
      return jsonResponse({ ok: false, error: `slug "${updated.slug}" 已被 "${dupSlug.name}" 占用` }, 409, request);
    }
  }

  const isRename = siteName !== updated.name;
  const jsonTags = JSON.stringify(updated.tags);
  const jsonNotes = updated.notes ? JSON.stringify(updated.notes) : "[]";
  const enabledInt = updated.enabled ? 1 : 0;

  // 改名用 UPDATE，不用 DELETE+INSERT。
  // 原因：name 只是 UNIQUE 约束，id 才是主键，UPDATE 完全可行。
  // 旧的 DELETE+INSERT 每次改名都换掉 id，且必须在 INSERT 里逐列重写——
  // 0003 加了 13 个新列之后，漏写就会静默清空 slug/quota_*/verified_*，
  // 实测：改名后 quota_tier=NULL、slug=NULL、sort_order=0。UPDATE 天然没有这个问题。
  const updateSites = db
    .prepare(
      `UPDATE sites SET
        name = ?, url = ?, original_url = ?, ref = ?, tags = ?, summary = ?,
        enabled = ?, checkin = ?, models = ?, rate = ?, register = ?, notes = ?,
        sort_order = ?,
        slug = ?, kind = ?, quota_min = ?, quota_max = ?, quota_unit = ?,
        quota_period = ?, quota_calls_est = ?, quota_tier = ?, quota_raw = ?,
        needs_proxy = ?, verified_at = ?, verified_by = ?,
        updated_at = datetime('now')
       WHERE name = ?`
    )
    .bind(
      updated.name, updated.url, updated.originalUrl || "", updated.ref || "",
      jsonTags, updated.summary || "", enabledInt,
      updated.checkin || "", updated.models || "", updated.rate || "",
      updated.register || "", jsonNotes, updated.sortOrder || 0,
      updated.slug ?? null, updated.kind ?? null,
      numOrNull(updated.quotaMin), numOrNull(updated.quotaMax),
      strOrNull(updated.quotaUnit), strOrNull(updated.quotaPeriod),
      intOrNull(updated.quotaCallsEst), strOrNull(updated.quotaTier),
      strOrNull(updated.quotaRaw), boolIntOrNull(updated.needsProxy),
      strOrNull(updated.verifiedAt), strOrNull(updated.verifiedBy),
      siteName
    );

  if (isRename) {
    // 改名时关联表一起搬，用 batch 保证原子性
    await dbBatch(db, [
      updateSites,
      db.prepare("UPDATE votes SET site_name = ? WHERE site_name = ?").bind(updated.name, siteName),
      db.prepare("UPDATE feedbacks SET site_name = ? WHERE site_name = ?").bind(updated.name, siteName),
    ]);
  } else {
    await dbBatch(db, [updateSites]);
  }

  // 联动：站点从禁用恢复为启用时，从死链接表移除对应 URL
  // （管理员明确恢复上线 = 认为 URL 已可达，与死链接黑名单矛盾，必须清除）
  if (updated.enabled && existing.enabled === 0 && updated.url) {
    await dbRun(db, "DELETE FROM dead_urls WHERE url = ?", [updated.url]);
  }

  return jsonResponse({ ok: true, site: updated }, 200, request);
}

/**
 * 删除站点（同时删除对应投票记录）
 * @param {object} db — D1 数据库实例
 * @param {object} request — Fetch Request
 * @param {string} siteName — 要删除的站点名称
 * @returns {Promise<Response>}
 */
export async function handleAdminDeleteSite(db, request, siteName) {
  // 必须把 url 一起取出来：下面的死链清理依赖 existing.url，
  // 原来只 SELECT name，existing.url 恒为 undefined，那段清理从来没执行过。
  const existing = await dbGet(db, "SELECT name, url FROM sites WHERE name = ?", [siteName]);
  if (!existing) {
    return jsonResponse({ ok: false, error: `站点 "${siteName}" 不存在` }, 404, request);
  }

  // 用 batch 保证原子性：站点删了但 votes/feedbacks 没删会留下孤儿数据，
  // 而这些表都以 site_name 关联，孤儿记录无法从任何界面定位到。
  const statements = [
    db.prepare("DELETE FROM sites WHERE name = ?").bind(siteName),
    db.prepare("DELETE FROM votes WHERE site_name = ?").bind(siteName),
    db.prepare("DELETE FROM feedbacks WHERE site_name = ?").bind(siteName),
  ];
  // 同步清理死链表中的孤立记录（站点已删除，其 URL 不应再留在黑名单）
  if (existing.url) {
    statements.push(db.prepare("DELETE FROM dead_urls WHERE url = ?").bind(existing.url));
  }
  await dbBatch(db, statements);

  return jsonResponse({ ok: true, deleted: siteName }, 200, request);
}

/**
 * 批量操作（删除、启用/停用、添加/移除标签）
 * @param {object} db — D1 数据库实例
 * @param {object} request — Fetch Request
 * @returns {Promise<Response>}
 */
export async function handleAdminBatch(db, request) {
  const parsed = await parseJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const { action, names, tag } = body;

  if (!action || !Array.isArray(names) || names.length === 0) {
    return jsonResponse({ ok: false, error: "需要 action 和 names 参数" }, 400, request);
  }

  // D1 单条查询最多 100 个绑定参数：names 超上限会生成 101+ 个占位符，
  // 查询必然失败并入全局 catch 返回 500。硬上限 + 逐条类型校验，防 DoS。
  if (names.length > 99 || !names.every((n) => typeof n === "string" && n.length > 0)) {
    return jsonResponse({ ok: false, error: "names 必须是 1-99 个非空字符串" }, 400, request);
  }

  let affected = 0;

  if (action === "delete") {
    const placeholders = names.map(() => "?").join(",");
    // 先取被删站点的 URL，用于清理死链表中的孤立记录
    const doomed = await dbAll(db, `SELECT url FROM sites WHERE name IN (${placeholders}) AND url != ''`, names);
    // batch 保证原子性：4 条 DELETE 要么都成功要么都不生效，不留孤儿
    const statements = [
      db.prepare(`DELETE FROM sites WHERE name IN (${placeholders})`).bind(...names),
      db.prepare(`DELETE FROM votes WHERE site_name IN (${placeholders})`).bind(...names),
      db.prepare(`DELETE FROM feedbacks WHERE site_name IN (${placeholders})`).bind(...names),
    ];
    if (doomed.length > 0) {
      const urlPlaceholders = doomed.map(() => "?").join(",");
      statements.push(
        db.prepare(`DELETE FROM dead_urls WHERE url IN (${urlPlaceholders})`).bind(...doomed.map((r) => r.url))
      );
    }
    const results = await dbBatch(db, statements);
    affected = results?.[0]?.meta?.changes || 0;
  } else if (action === "enable" || action === "disable") {
    const enableVal = action === "enable" ? 1 : 0;
    const placeholders = names.map(() => "?").join(",");
    const result = await dbRun(
      db,
      `UPDATE sites SET enabled = ?, updated_at = datetime('now') WHERE name IN (${placeholders})`,
      [enableVal, ...names]
    );
    affected = result.meta?.changes || 0;
    // 联动：批量启用站点时，从死链接表移除对应 URL（启用 = 认为可达）
    if (action === "enable") {
      const rows = await dbAll(db, `SELECT url FROM sites WHERE name IN (${placeholders}) AND url != ''`, names);
      const urls = rows.map((r) => r.url);
      if (urls.length > 0) {
        const urlPlaceholders = urls.map(() => "?").join(",");
        await dbRun(db, `DELETE FROM dead_urls WHERE url IN (${urlPlaceholders})`, urls);
      }
    }
  } else if (action === "add_tag" || action === "remove_tag") {
    if (!tag) {
      return jsonResponse(
        { ok: false, error: "add_tag/remove_tag 需要 tag 参数" },
        400,
        request
      );
    }
    // 标签是 JSON 数组，SQLite 里直接改比较麻烦，所以在 JS 里算。
    // 但不再逐条往返：原来是 N 次 SELECT + N 次 UPDATE（18 条站点 = 36 次 D1 往返，
    // 而 D1 查询计入 Workers 的 50 subrequest 配额），改成 1 次 SELECT + 1 次 batch。
    const placeholders = names.map(() => "?").join(",");
    const rows = await dbAll(db, `SELECT name, tags FROM sites WHERE name IN (${placeholders})`, names);

    const statements = [];
    for (const row of rows) {
      const tags = row.tags ? JSON.parse(row.tags) : [];
      let changed = false;
      if (action === "add_tag" && !tags.includes(tag)) {
        tags.push(tag);
        changed = true;
      } else if (action === "remove_tag") {
        const idx = tags.indexOf(tag);
        if (idx !== -1) {
          tags.splice(idx, 1);
          changed = true;
        }
      }
      if (changed) {
        statements.push(
          db
            .prepare("UPDATE sites SET tags = ?, updated_at = datetime('now') WHERE name = ?")
            .bind(JSON.stringify(tags), row.name)
        );
      }
    }
    if (statements.length > 0) {
      await dbBatch(db, statements);
    }
    affected = statements.length;
  } else {
    return jsonResponse({ ok: false, error: `未知操作: ${action}` }, 400, request);
  }

  return jsonResponse({ ok: true, action, affected }, 200, request);
}

/**
 * 导出完整站点数据
 * @param {object} db — D1 数据库实例
 * @param {object} request — Fetch Request
 * @returns {Promise<Response>}
 */
export async function handleAdminExport(db, request) {
  const data = await handleGetSites(db);
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="sites-${data.metadata?.updatedAt || "export"}.json"`,
      "Access-Control-Allow-Origin": request.headers.get("Origin") || "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

/**
 * 批量导入站点（智能解析 URL，自动剥离推广参数，以干净 URL 去重）
 * @param {object} db — D1 数据库实例
 * @param {object} request — Fetch Request
 * @returns {Promise<Response>}
 */
export async function handleAdminImportSites(db, request) {
  const parsed = await parseJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  // 支持两种格式：{ sites: [...] } 或 [...]
  const incoming = Array.isArray(body) ? body : body.sites;
  const overwrite = body.overwrite || false;

  if (!Array.isArray(incoming) || incoming.length === 0) {
    return jsonResponse({ ok: false, error: "需要 sites 数组" }, 400, request);
  }
  if (incoming.length > IMPORT_MAX_BATCH) {
    return jsonResponse(
      { ok: false, error: `单次最多导入 ${IMPORT_MAX_BATCH} 条` },
      400,
      request
    );
  }

  // 获取现有站点的干净 URL 映射
  const existingSites = await dbAll(db, "SELECT name, url FROM sites");
  const existingCleanUrls = new Map();
  for (const s of existingSites) {
    const { cleanUrl } = parseSiteUrl(s.url);
    existingCleanUrls.set(cleanUrl, s.name);
  }

  // 加载死链接列表，导入时过滤
  const deadUrls = await getDeadUrls(db);

  let added = 0,
    skipped = 0,
    updated = 0,
    deadFiltered = 0;
  const duplicates = [];
  const statements = [];

  for (const item of incoming) {
    if (!item.name || !item.url) {
      skipped++;
      continue;
    }

    // H1 修复：与 create/update/submissions 路径一致，导入也必须校验 URL 协议。
    // 此前 validateUrlProtocol 唯独漏了这里——javascript:/data: URL 能原样入库，
    // 而前端 esc() 只转义 HTML 实体、不校验 scheme，点击链接即在页面源内执行
    // JS（admin 页可窃取 localStorage 里的管理 Token），属存储型 XSS。
    const urlCheck = validateUrlProtocol(item.url);
    if (!urlCheck.ok) {
      skipped++;
      continue;
    }

    // 死链接过滤
    const { cleanUrl: checkUrl } = parseSiteUrl(item.url);
    if (deadUrls[checkUrl] || deadUrls[item.url]) {
      deadFiltered++;
      continue;
    }

    const { originalUrl, cleanUrl, ref } = parseSiteUrl(item.url);
    const existingName = existingCleanUrls.get(cleanUrl);

    if (existingName) {
      if (overwrite) {
        statements.push(
          db.prepare(
            `UPDATE sites SET
              url = ?, original_url = ?, ref = ?, tags = ?, summary = ?,
              checkin = ?, models = ?, rate = ?, register = ?, notes = ?,
              updated_at = datetime('now')
             WHERE name = ?`
          ).bind(
              cleanUrl,
              originalUrl || "",
              ref || "",
              JSON.stringify(item.tags || []),
              item.summary || "",
              item.checkin || "",
              item.models || "",
              item.rate || "",
              item.register || "",
              JSON.stringify(item.notes || []),
              existingName
          )
        );
        updated++;
      } else {
        duplicates.push({ name: item.name, url: cleanUrl, existingName });
        skipped++;
      }
      continue;
    }

    // 新站点
    statements.push(
      db.prepare(
        `INSERT INTO sites (name, url, original_url, ref, tags, summary, checkin, models, rate, register, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
      ).bind(
          item.name,
          cleanUrl,
          originalUrl && originalUrl !== cleanUrl ? originalUrl : "",
          ref || "",
          JSON.stringify(item.tags || []),
          item.summary || "",
          item.checkin || "",
          item.models || "",
          item.rate || "",
          item.register || "",
          JSON.stringify(item.notes || [])
      )
    );
    existingCleanUrls.set(cleanUrl, item.name);
    added++;
  }

  // Free 计划每次 Worker 调用最多 50 次 D1 查询，batch 内每条语句都计入。
  // 500 条一次性 batch 会直接触发 1101 配额错误（此前与 IMPORT_MAX_BATCH=500
  // 自相矛盾）。按每批 40 条循环提交，给同次调用的 SELECT（现有站点/死链
  // 读取）留出余量。
  const IMPORT_BATCH_SIZE = 40;
  for (let i = 0; i < statements.length; i += IMPORT_BATCH_SIZE) {
    await db.batch(statements.slice(i, i + IMPORT_BATCH_SIZE));
  }

  return jsonResponse(
    {
      ok: true,
      imported: incoming.length,
      added,
      updated,
      skipped,
      deadFiltered: deadFiltered > 0 ? deadFiltered : undefined,
      duplicates: duplicates.length > 0 ? duplicates : undefined,
    },
    200,
    request
  );
}
