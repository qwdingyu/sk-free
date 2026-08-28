// ═══════════════════════════════════════════════════════════════════════════════
// index.js — Worker 入口：路由分发 + 管理页面 HTML
// 所有业务逻辑已拆分到 src/ 目录下的独立模块
// ═══════════════════════════════════════════════════════════════════════════════

// ── 模块导入 ──────────────────────────────────────────────────────────────────
import { getDb, dbAll, dbGet, dbRun, dbBatch } from "./src/db.js";
import { DEFAULT_SCHEMA, getSchema, saveSchema } from "./src/schema.js";
import {
  corsHeaders, json, html, requireAuth,
  cleanupAdminRateMap, checkAdminRateLimit, parseJsonBody
} from "./src/utils.js";
import {
  handleGetSites, handleGetEnabledSites, handleAdminListSites,
  handleAdminCreateSite, handleAdminUpdateSite, handleAdminDeleteSite,
  handleAdminBatch, handleAdminExport, handleAdminImportSites
} from "./src/sites.js";
import { handleGetVotes, handleVote } from "./src/votes.js";
import { handleSubmitSite, handleAdminGetSubmissions, handleAdminSubmissionAction, handleAdminApproveSubmission, handleAdminBatchSubmissions } from "./src/submissions.js";
import { getDeadUrls, addDeadUrl, removeDeadUrl, batchDeadUrls } from "./src/deadurls.js";
import { checkUrlHealth, checkBatchHealth, HEALTH_BATCH_SIZE } from "./src/health.js";
import { handleSubmitFeedback, handleGetFeedbacks, handleFeedbackAction, handleAdminBatchFeedbacks } from "./src/feedbacks.js";

// ═══════════════════════════════════════════════════════════════════════════════
// Worker 入口 — 路由分发
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
      const db = getDb(env);

      // ── 静态资源（Vite 构建产物在 public/_app/）────────────────────
      const assets = env.ASSETS;
      if (path.startsWith("/_app/")) {
        return assets.fetch(request);
      }

      // ── 公告接口（从 KV 读取）──────────────────────────────
      if (path === "/api/notice" && request.method === "GET") {
        const notice = await kv.get("notice.md");
        return json({ ok: true, notice: notice || "" }, 200, request);
      }

      // ── Broadcast 首页 ──────────────────────────────────────
      if (path === "/" && request.method === "GET") {
        const appRequest = new Request(`${url.origin}/_app/index.html`, request);
        const appResponse = await assets.fetch(appRequest);
        if (appResponse.status === 200) return appResponse;
        return new Response("Frontend assets missing. Run npm run frontend:build before deploy.", { status: 503 });
      }

      // ── 管理后台 ────────────────────────────────────────────
      if (path === "/admin" && request.method === "GET") {
        const adminRequest = new Request(`${url.origin}/_app/admin.html`, request);
        const adminResponse = await assets.fetch(adminRequest);
        if (adminResponse.status === 200) return adminResponse;
        return new Response("Frontend assets missing. Run npm run frontend:build before deploy.", { status: 503 });
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
          return handleAdminImportSites(db, request);
        }

        // GET /api/admin/sites
        if (path === "/api/admin/sites" && request.method === "GET") {
          const result = await handleAdminListSites(db, request);
          return json(result, 200, request);
        }
        // POST /api/admin/sites
        if (path === "/api/admin/sites" && request.method === "POST") {
          return handleAdminCreateSite(db, request, kv);
        }
        // POST /api/admin/sites/batch
        if (path === "/api/admin/sites/batch" && request.method === "POST") {
          const batchBody = await request.clone().json().catch(() => ({}));
          if (batchBody.action === "approve_submission" || batchBody.action === "reject_submission") {
            const ids = Array.isArray(batchBody.ids) ? batchBody.ids : (batchBody.id ? [batchBody.id] : []);
            if (ids.length === 0) {
              return json({ ok: false, error: "需要 id 或 ids 参数" }, 400, request);
            }
            const result = await handleAdminBatchSubmissions(db, batchBody.action, ids);
            const status = result.ok ? 200 : (result.error === "提交不存在" ? 404 : 400);
            return json(result, status, request);
          }
          return handleAdminBatch(db, request);
        }
        // GET /api/admin/export
        if (path === "/api/admin/export" && request.method === "GET") {
          return handleAdminExport(db, request);
        }
        // GET /api/admin/submissions
        if (path === "/api/admin/submissions" && request.method === "GET") {
          const status = url.searchParams.get("status") || undefined;
          const result = await handleAdminGetSubmissions(db, status);
          return json(result, 200, request);
        }
        // POST /api/admin/submissions/:id/approve — 原子批准（建站+标记，M6）
        // 取代原来前端"先建站再标记批准"的两步流程（中间失败会留半完成状态）
        const approveMatch = path.match(/^\/api\/admin\/submissions\/([^/]+)\/approve$/);
        if (approveMatch && request.method === "POST") {
          const result = await handleAdminApproveSubmission(db, decodeURIComponent(approveMatch[1]));
          const status = !result.ok
            ? (result.error === "提交不存在或已处理" ? 404 : 409)
            : 201;
          return json(result, status, request);
        }
        // PUT /api/admin/sites/:name
        const putMatch = path.match(/^\/api\/admin\/sites\/(.+)$/);
        if (putMatch && request.method === "PUT") {
          return handleAdminUpdateSite(db, request, decodeURIComponent(putMatch[1]));
        }
        // DELETE /api/admin/sites/:name
        if (putMatch && request.method === "DELETE") {
          return handleAdminDeleteSite(db, request, decodeURIComponent(putMatch[1]));
        }

        // ── Dead URLs ─────────────────────────────────────────

        // GET /api/admin/dead-urls
        if (path === "/api/admin/dead-urls" && request.method === "GET") {
          const deadUrls = await getDeadUrls(db);
          return json({ ok: true, deadUrls }, 200, request);
        }
        // POST /api/admin/dead-urls — 添加/移除单条死链接
        if (path === "/api/admin/dead-urls" && request.method === "POST") {
          const parsed = await parseJsonBody(request);
          if (!parsed.ok) return parsed.response;
          const { url: deadUrl, action, reason } = parsed.data;
          if (!deadUrl || !action) return json({ ok: false, error: "需要 url 和 action 参数" }, 400, request);
          if (action === "add") {
            await addDeadUrl(db, deadUrl, { reason: reason || "unreachable" });
          } else if (action === "remove") {
            await removeDeadUrl(db, deadUrl);
          } else {
            return json({ ok: false, error: "action 只能是 add 或 remove" }, 400, request);
          }
          const deadUrls = await getDeadUrls(db);
          return json({ ok: true, count: Object.keys(deadUrls).length }, 200, request);
        }
        // POST /api/admin/dead-urls/batch — 批量添加/移除死链接
        if (path === "/api/admin/dead-urls/batch" && request.method === "POST") {
          const parsed = await parseJsonBody(request);
          if (!parsed.ok) return parsed.response;
          const { urls, action = "remove" } = parsed.data;
          if (!Array.isArray(urls) || urls.length === 0) {
            return json({ ok: false, error: "需要 urls 数组" }, 400, request);
          }
          const { changed } = await batchDeadUrls(db, urls, action);
          const deadUrls = await getDeadUrls(db);
          return json({ ok: true, changed, action, count: Object.keys(deadUrls).length }, 200, request);
        }

        // ── Health Check ──────────────────────────────────────

        // POST /api/admin/check-url — 检查单个 URL
        if (path === "/api/admin/check-url" && request.method === "POST") {
          const parsed = await parseJsonBody(request);
          if (!parsed.ok) return parsed.response;
          const { url: checkUrl } = parsed.data;
          if (!checkUrl) return json({ ok: false, error: "需要 url 参数" }, 400, request);
          const result = await checkUrlHealth(checkUrl);
          return json({ ok: true, url: checkUrl, ...result }, 200, request);
        }
        // POST /api/admin/check-batch — 批量检查 URL 健康状态
        // 纯只读探针：只返回扫描结果，绝不写状态。
        // 状态变更（启用/停用）只发生在 /api/admin/sites/batch 的 enable/disable，
        // 由管理员在对账报告里点按钮触发。探针是证据，不是行动。
        // （曾在此处有"可达即自动恢复 enabled=1"的逻辑，已删除——
        //  它让一次扫描静默翻转 15 个站点的决定层状态，且与 cron
        //  "失败绝不禁用"的原则不对称。）
        if (path === "/api/admin/check-batch" && request.method === "POST") {
          const parsed = await parseJsonBody(request);
          if (!parsed.ok) return parsed.response;
          const urls = parsed.data.urls;
          if (!Array.isArray(urls) || urls.length === 0) {
            return json({ ok: false, error: "需要 urls 数组" }, 400, request);
          }
          const result = await checkBatchHealth(db, urls, 8000);
          return json(result, 200, request);
        }

        // ── Feedbacks ─────────────────────────────────────────

        // GET /api/admin/feedbacks — 获取反馈列表（admin 专用）
        if (path === "/api/admin/feedbacks" && request.method === "GET") {
          const status = url.searchParams.get("status") || undefined;
          const result = await handleGetFeedbacks(db, status);
          return json(result, 200, request);
        }
        // POST /api/admin/feedbacks/:id — 处理反馈（标记已读/已解决/删除）
        const fbMatch = path.match(/^\/api\/admin\/feedbacks\/(\d+)$/);
        if (fbMatch && request.method === "POST") {
          const parsed = await parseJsonBody(request);
          if (!parsed.ok) return parsed.response;
          const result = await handleFeedbackAction(db, parseInt(fbMatch[1]), parsed.data.action);
          return json(result, result.ok ? 200 : 400, request);
        }
        // POST /api/admin/feedbacks/batch — 批量处理反馈
        if (path === "/api/admin/feedbacks/batch" && request.method === "POST") {
          const parsed = await parseJsonBody(request);
          if (!parsed.ok) return parsed.response;
          const { action, ids } = parsed.data;
          try {
            const result = await handleAdminBatchFeedbacks(db, action, ids);
            return json(result, result.ok ? 200 : 400, request);
          } catch (e) {
            console.error("[feedbacks-batch] error:", e);
            return json({ ok: false, error: "服务器内部错误: " + (e.message || e) }, 500, request);
          }
        }

        // ── Schema ────────────────────────────────────────────

        // GET /api/admin/schema
        if (path === "/api/admin/schema" && request.method === "GET") {
          const schema = await getSchema(kv);
          return json({ ok: true, schema }, 200, request);
        }
        // PUT /api/admin/schema — 更新 Schema（全量替换）
        if (path === "/api/admin/schema" && request.method === "PUT") {
          const parsed = await parseJsonBody(request);
          if (!parsed.ok) return parsed.response;
          const newSchema = parsed.data;
          if (!newSchema.fields || !Array.isArray(newSchema.fields)) {
            return json({ ok: false, error: "schema 必须包含 fields 数组" }, 400, request);
          }
          for (const f of newSchema.fields) {
            if (!f.key || !f.label || !f.type) {
              return json({ ok: false, error: `字段缺少必填属性 (key/label/type): ${JSON.stringify(f)}` }, 400, request);
            }
            const validTypes = ["text", "url", "textarea", "number", "tags", "list", "select", "boolean", "date", "rating"];
            if (!validTypes.includes(f.type)) {
              return json({ ok: false, error: `字段类型无效: ${f.type}，支持: ${validTypes.join(", ")}` }, 400, request);
            }
          }
          const merged = {
            ...DEFAULT_SCHEMA, ...newSchema, fields: newSchema.fields,
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

      // GET /api/schema
      if (path === "/api/schema" && request.method === "GET") {
        const schema = await getSchema(kv);
        return json({ ok: true, schema }, 200, request);
      }

      // GET /api/sites — 返回全量站点（含停用），死链由前端 dead 标记折叠展示
      if (path === "/api/sites" && request.method === "GET") {
        const data = await handleGetEnabledSites(db);
        return json(data, 200, request);
      }

      // POST /api/submit — 用户提交新站点
      if (path === "/api/submit" && request.method === "POST") {
        return handleSubmitSite(request, db);
      }

      // POST /api/feedback — 用户提交反馈（报错/纠正/好评）
      if (path === "/api/feedback" && request.method === "POST") {
        return handleSubmitFeedback(request, db);
      }

      // GET /api/votes
      if (path === "/api/votes" && request.method === "GET") {
        const data = await handleGetVotes(db);
        return json(data, 200, request);
      }

      // POST /api/vote
      if (path === "/api/vote" && request.method === "POST") {
        return handleVote(request, db);
      }

      // GET /api/health
      if (path === "/api/health") {
        return json({ ok: true, timestamp: Date.now() }, 200, request);
      }

      // 404
      return json({ ok: false, error: "Not Found" }, 404, request);

    } catch (e) {
      // M2 修复：此前把 e.message 原样回传（"Internal error: <细节>"），
      // SQL/堆栈/路径等内部结构可被攻击者侦察。生产环境返回固定文案，
      // 细节只进日志。
      console.error("Unhandled error:", e && e.stack ? e.stack : e);
      return json({ ok: false, error: "服务器内部错误，请稍后重试" }, 500, request);
    }
  },

  // ── Cron Trigger：定时健康检查 ────────────────────────────────────────────
  // 每6小时自动检查所有启用站点的 URL 可达性
  // 写入 verified_at/verified_by 字段，为前端鲜度可视化提供数据
  // 设计：失败绝不自动下线（概率性探测不驱动不可逆动作），
  //       只累计 health_fail_count 供管理员判断，成功则清零。
  async scheduled(event, env, ctx) {
    const db = getDb(env);
    try {
      // ── 每次 cron 只检查一个"预算安全"的切片，绝不遍历全表 ──────────────────
      //
      // 50 个 subrequest 的上限是**每次调用**的，不是每批次的。原来的写法是
      //   for (i = 0; i < sites.length; i += 20)
      // 把全表分批跑完 —— 批次只限制并发，不限制单次调用的总量。
      // 实测（stub fetch 计数，忠实复刻本循环，最坏情况即所有 HEAD 都失败、
      // 每个 URL 消耗 2 个 fetch）：
      //   18 站 → 38 subreq ✅    22 站 → 47 ✅    23 站 → 49 ✅
      //   24 站 → 51 ❌           30 站 → 63 ❌    40 站 → 83 ❌
      // 也就是说站点数一过 23，cron 就会 1101 整体失败，verified_at 一次都写
      // 不进去，前端鲜度永远显示"未验证" —— 正是之前已经踩过的那个坑，
      // 只是当时的触发条件是批次太大，这次的触发条件是站点变多。
      // 线上现在 18 个站，离 23 只剩 5 个的余量，属于随时会炸。
      //
      // 切片怎么选：
      //   前一半额度给"从未验证过的"（verified_at IS NULL），其中优先检查
      //   历史检查次数最少的（health_fail_count 小），保证同组内轮转；
      //   剩下的额度给"验证时间最老的"。
      //   一半一半是为了防饿死：如果只按"从未验证优先"，一旦长期失效的站点
      //   攒到 20 个以上，它们会永久占满整个切片，健康站点再也不会被复验，
      //   所有人的鲜度一起烂掉。
      const BATCH = HEALTH_BATCH_SIZE;
      // Math.max(1, …)：万一有人把 HEALTH_BATCH_SIZE 调成 1，floor(1/2)=0 会让
      // "从未验证"这一组永远拿不到额度，新站点的鲜度永远写不进去。
      const HALF = Math.max(1, Math.floor(BATCH / 2));

      const never = await dbAll(
        db,
        `SELECT id, name, url FROM sites
          WHERE enabled = 1 AND url != '' AND verified_at IS NULL
          ORDER BY health_fail_count ASC, id ASC
          LIMIT ?`,
        [HALF]
      );
      const stale = await dbAll(
        db,
        `SELECT id, name, url FROM sites
          WHERE enabled = 1 AND url != '' AND verified_at IS NOT NULL
          ORDER BY verified_at ASC
          LIMIT ?`,
        [BATCH - never.length]
      );
      const batch = [...never, ...stale];
      if (batch.length === 0) return;

      // fallback 预算：每个 URL 先占 1 个 HEAD，剩余额度才允许 GET 复核。
      // 上面用了 2 次 SELECT，下面还有 1 次 dbBatch，共 3 个 subrequest，
      // 所以留给 fetch 的额度是 50-3=47；BATCH=20 时最坏 40 个 fetch，安全。
      const FETCH_BUDGET_HERE = 47;
      const fallbackQuota = Math.max(0, FETCH_BUDGET_HERE - batch.length);
      const deadline = Date.now() + 25000;
      const results = await Promise.all(
        batch.map(async (site, idx) => {
          const r = await checkUrlHealth(site.url, undefined, {
            allowFallback: idx < fallbackQuota,
            deadline,
          });
          return { ...site, ...r };
        })
      );

      const stmts = results.map((r) =>
        r.ok
          ? // 成功：更新验证时间并把失败计数清零
            db
              .prepare(
                "UPDATE sites SET verified_at = datetime('now'), verified_by = 'healthcheck', health_fail_count = 0 WHERE id = ?"
              )
              .bind(r.id)
          : // 失败：只累计计数，不动 enabled、不写 dead_urls。
            // 连续失败到多少次算"确认失效"由管理员看着计数决定。
            db
              .prepare(
                "UPDATE sites SET health_fail_count = health_fail_count + 1 WHERE id = ?"
              )
              .bind(r.id)
      );
      if (stmts.length > 0) {
        await dbBatch(db, stmts);
      }
      const checked = results.length;
      const alive = results.filter((r) => r.ok).length;

      // Cron 执行日志（Cloudflare Dashboard 可查看）。
      // 打出"本次检查 / 待检总数"，这样站点变多、单次覆盖不全时能立刻看出来，
      // 而不是等到用户发现鲜度不对。cron 每 6 小时一次 = 每天 4 轮，
      // 每轮最多 BATCH 个，全量扫完一遍需要 ceil(总数 / BATCH) 轮。
      const totalRow = await dbGet(
        db,
        "SELECT COUNT(*) AS n FROM sites WHERE enabled = 1 AND url != ''"
      );
      const total = totalRow?.n ?? checked;
      const rounds = Math.ceil(total / BATCH);
      console.log(
        `[cron] health check: ${checked}/${total} checked, ${alive} alive, ${checked - alive} dead` +
          (rounds > 1 ? `（全量扫完需 ${rounds} 轮，约 ${rounds * 6} 小时）` : "")
      );
    } catch (e) {
      console.error("[cron] health check failed:", e.message);
    }
  }
};
