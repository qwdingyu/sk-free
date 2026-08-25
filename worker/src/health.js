// ═══════════════════════════════════════════════════════════════════════════════
// health.js — 链接健康检查 + check-batch 批量检测
// ═══════════════════════════════════════════════════════════════════════════════

import { getDeadUrls } from "./deadurls.js";

// 默认超时时间（毫秒）
const DEFAULT_TIMEOUT_MS = 8000;

// ─── subrequest 预算 ─────────────────────────────────────────────────────────
// Workers Free 每次调用上限 50 个 subrequest，**D1 查询也计入这个配额**。
//
// 为什么批次是 20 而不是 45：
//   加了 HEAD→GET fallback 之后，每个 URL 最坏消耗 2 个 fetch。
//   旧代码前端每批发 45、注释写"≤48 fetch = ≤49 subreq 安全"——
//   只要有 5 个 URL 的 HEAD 失败就是 45+5+1(D1)=51，直接 1101 整批失败。
//   而 fallback 恰恰是为"HEAD 会失败"准备的：它越有用越容易把自己撑爆。
//   20 × 2 = 40 个 fetch + D1 读写，留足余量。
export const HEALTH_BATCH_SIZE = 20;

// 留给 D1 读写和其它开销的余量之外，可用于 fetch 的 subrequest 上限
const FETCH_BUDGET = 44;

// 整批的墙钟上限：并发发起，正常 ~8s，含 fallback 最坏 ~16s。
// 超过这个时间就不再发起 fallback，避免管理端界面长时间无响应。
const GLOBAL_DEADLINE_MS = 25000;

/**
 * 检查单个 URL 的健康状态
 * 策略：HEAD 优先 → 失败时 fallback GET + Range: bytes=0-0 → 放宽存活判定
 *
 * 设计原则：健康检查是概率性探测（网络抖动、WAF 挑战、限流），
 * 不能把单次探测结果直接接到不可逆的下线动作上。
 *
 * @param {string} url — 目标 URL
 * @param {number} [timeoutMs] — 单次请求超时时间（毫秒），默认 8000ms
 * @param {object} [opts] — { allowFallback: boolean, deadline: number }
 * @returns {Promise<{ ok: boolean, status?: number, error?: string, method?: string, timeMs: number }>}
 */
export async function checkUrlHealth(url, timeoutMs = DEFAULT_TIMEOUT_MS, opts = {}) {
  const { allowFallback = true, deadline = Infinity } = opts;
  const start = Date.now();
  const headers = {
    "User-Agent": "Mozilla/5.0 (compatible; sk-free-health-check/1.0)",
  };

  let headError = null;

  try {
    // 第一次尝试：HEAD（最轻量，大多数站点支持）
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        method: "HEAD",
        redirect: "follow",
        signal: controller.signal,
        headers,
      });
    } finally {
      clearTimeout(timer);
    }

    // 放宽存活判定：能回 2xx/3xx/4xx 都说明服务器在响应
    // 403(WAF/CF 挑战)、405(不支持 HEAD)、429(限流)、501(未实现) 都是"活的"
    // 只有 5xx（服务端错误）和网络层错误才算"可能死了"
    if (res.status < 500) {
      return { ok: true, status: res.status, method: "HEAD", timeMs: Date.now() - start };
    }
    headError = `HTTP ${res.status}`;
  } catch (err) {
    headError = err.name === "AbortError" ? "timeout" : err.message;
  }

  // HEAD 判定为"可能死了"。是否再花一个 subrequest 做 GET 复核，取决于预算和时间。
  if (!allowFallback || Date.now() > deadline) {
    return {
      ok: false,
      status: 0,
      error: headError,
      method: "HEAD",
      fallbackSkipped: true,
      timeMs: Date.now() - start,
    };
  }

  try {
    // 第二次尝试：GET + Range: bytes=0-0（最小数据量，绕过不支持 HEAD 的服务器）
    // 实测 agentrouter.org/register 的 HEAD 会挂起 5 秒被断开，GET 却是 200。
    const controller2 = new AbortController();
    const timer2 = setTimeout(() => controller2.abort(), timeoutMs);
    let res2;
    try {
      res2 = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: controller2.signal,
        headers: { ...headers, Range: "bytes=0-0" },
      });
    } finally {
      clearTimeout(timer2);
    }

    // GET fallback 同样放宽判定
    return {
      ok: res2.status < 500,
      status: res2.status,
      method: "GET",
      timeMs: Date.now() - start,
    };
  } catch (err2) {
    return {
      ok: false,
      status: 0,
      error: err2.name === "AbortError" ? "timeout" : err2.message,
      method: "GET",
      timeMs: Date.now() - start,
    };
  }
}

/**
 * 批量检查 URL 健康状态
 * 前端按 HEALTH_BATCH_SIZE 分批调用；本函数再做一次硬截断兜底。
 * @param {object} db — D1 数据库实例
 * @param {string[]} urls — URL 数组
 * @param {number} [timeoutMs] — 每个 URL 的超时时间
 * @returns {Promise<object>} { ok, total, alive, dead, newDeadUrls, results, maxBatch, truncated }
 */
export async function checkBatchHealth(db, urls, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (!Array.isArray(urls) || urls.length === 0) {
    return { ok: false, error: "需要 urls 数组" };
  }

  // 先读取死链接列表（1 次 D1 读取，计入 subrequest 配额）
  const deadUrls = await getDeadUrls(db);

  const targets = urls.slice(0, HEALTH_BATCH_SIZE);
  const truncated = urls.length > targets.length;

  // 预算分配（确定性，不依赖并发时序）：
  //   每个 URL 先占 1 个 HEAD，剩余额度用于 fallback。
  //   HEALTH_BATCH_SIZE=20 时剩 24 > 20，即所有 URL 都允许 fallback；
  //   万一将来有人把批次调大，这里会自动收紧而不是静默超限。
  const fallbackQuota = Math.max(0, FETCH_BUDGET - targets.length);
  const deadline = Date.now() + GLOBAL_DEADLINE_MS;

  const results = await Promise.all(
    targets.map(async (url, i) => {
      const r = await checkUrlHealth(url, timeoutMs, {
        allowFallback: i < fallbackQuota,
        deadline,
      });
      return { url, ...r };
    })
  );

  // 识别新发现的死链接（不在已有黑名单中的）
  const newDeadUrls = results.filter((r) => !r.ok && !deadUrls[r.url]).map((r) => r.url);
  const alive = results.filter((r) => r.ok).length;
  const dead = results.filter((r) => !r.ok).length;

  return {
    ok: true,
    total: results.length,
    alive,
    dead,
    newDeadUrls,
    results,
    maxBatch: HEALTH_BATCH_SIZE,
    truncated,
  };
}
