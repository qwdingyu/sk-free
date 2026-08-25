// ═══════════════════════════════════════════════════════════════════════════════
// sites.js — 站点 CRUD + 导入导出（D1 版本）
// 从 KV 全量 JSON 重写迁移到 D1 单行 INSERT/UPDATE/DELETE
// ═══════════════════════════════════════════════════════════════════════════════

import { dbAll, dbGet, dbRun, dbBatch } from "./db.js";
import { getDeadUrls } from "./deadurls.js";
import { json as jsonResponse, parseJsonBody, validateUrlProtocol, parseSiteUrl } from "./utils.js";

// 导入限制
const IMPORT_MAX_BATCH = 500;

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

  const voteMap = {};
  for (const v of votes) {
    voteMap[v.site_name] = { up: v.up_count, down: v.down_count };
  }

  return {
    ok: true,
    sites: sites.map((s) => ({
      ...formatSiteRow(s),
      votes: voteMap[s.name] || { up: 0, down: 0 },
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
  // 查询启用站点 + 死链接黑名单，排除已被健康检查标记为不可达的站点
  // 闭环：管理员在后台检测出的死链接必须从首页消失
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

  return {
    ok: true,
    sites: sites
      .filter((s) => !deadUrlSet.has(s.url))
      .map((s) => ({
        ...formatSiteRow(s),
        votes: voteMap[s.name] || { up: 0, down: 0 },
      })),
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

  await dbRun(
    db,
    `INSERT INTO sites (name, url, original_url, ref, tags, summary, enabled, checkin, models, rate, register, notes, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
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

  // 合并更新（保留未提供的字段）
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
  };

  // 清除 undefined 字段
  Object.keys(updated).forEach((k) => updated[k] === undefined && delete updated[k]);

  const isRename = siteName !== updated.name;
  const jsonTags = JSON.stringify(updated.tags);
  const jsonNotes = updated.notes ? JSON.stringify(updated.notes) : "[]";
  const enabledInt = updated.enabled ? 1 : 0;

  if (isRename) {
    // 改名：DELETE 旧记录 + INSERT 新记录 + 同步 votes，用 batch 保证原子性
    const statements = [
      db.prepare("DELETE FROM sites WHERE name = ?").bind(siteName),
      db.prepare(
        `INSERT INTO sites (name, url, original_url, ref, tags, summary, enabled, checkin, models, rate, register, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
      ).bind(
        updated.name, updated.url, updated.originalUrl || "", updated.ref || "",
        jsonTags, updated.summary || "", enabledInt,
        updated.checkin || "", updated.models || "", updated.rate || "",
        updated.register || "", jsonNotes, existing.created_at
      ),
      db.prepare("UPDATE votes SET site_name = ? WHERE site_name = ?").bind(updated.name, siteName),
    ];
    await dbBatch(db, statements);
  } else {
    // 不改名：单条 UPDATE
    await dbRun(
      db,
      `UPDATE sites SET
        url = ?, original_url = ?, ref = ?, tags = ?, summary = ?,
        enabled = ?, checkin = ?, models = ?, rate = ?, register = ?, notes = ?,
        updated_at = datetime('now')
       WHERE name = ?`,
      [
        updated.url, updated.originalUrl || "", updated.ref || "",
        jsonTags, updated.summary || "", enabledInt,
        updated.checkin || "", updated.models || "", updated.rate || "",
        updated.register || "", jsonNotes, siteName,
      ]
    );
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
  const existing = await dbGet(db, "SELECT name FROM sites WHERE name = ?", [siteName]);
  if (!existing) {
    return jsonResponse({ ok: false, error: `站点 "${siteName}" 不存在` }, 404, request);
  }

  await dbRun(db, "DELETE FROM sites WHERE name = ?", [siteName]);
  await dbRun(db, "DELETE FROM votes WHERE site_name = ?", [siteName]);

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

  let affected = 0;

  if (action === "delete") {
    const placeholders = names.map(() => "?").join(",");
    const result = await dbRun(db, `DELETE FROM sites WHERE name IN (${placeholders})`, names);
    affected = result.meta?.changes || 0;
    await dbRun(db, `DELETE FROM votes WHERE site_name IN (${placeholders})`, names);
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
    // 标签操作需逐条处理（JSON 数组操作在 SQLite 中较复杂）
    for (const name of names) {
      const row = await dbGet(db, "SELECT tags FROM sites WHERE name = ?", [name]);
      if (!row) continue;
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
        await dbRun(
          db,
          "UPDATE sites SET tags = ?, updated_at = datetime('now') WHERE name = ?",
          [JSON.stringify(tags), name]
        );
        affected++;
      }
    }
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

  // 执行批量操作
  if (statements.length > 0) {
    await db.batch(statements);
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
