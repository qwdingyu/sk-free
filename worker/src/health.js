// ═══════════════════════════════════════════════════════════════════════════════
// health.js — 链接健康检查 + check-batch 批量检测
// ═══════════════════════════════════════════════════════════════════════════════

import { getDeadUrls } from "./deadurls.js";

// 默认超时时间（毫秒）
const DEFAULT_TIMEOUT_MS = 8000;

/**
 * 检查单个 URL 的健康状态
 * 策略：HEAD 优先 → 失败时 fallback GET + Range: bytes=0-0 → 放宽存活判定
 *
 * 设计原则：健康检查是概率性探测（网络抖动、WAF 挑战、限流），
 * 不能把单次探测结果直接接到不可逆的下线动作上。
 *
 * @param {string} url — 目标 URL
 * @param {number} [timeoutMs] — 超时时间（毫秒），默认 8000ms
 * @returns {Promise<{ ok: boolean, status?: number, error?: string, timeMs: number }>}
 */
export async function checkUrlHealth(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const start = Date.now();
  const headers = {
    "User-Agent": "Mozilla/5.0 (compatible; sk-free-health-check/1.0)",
  };

  try {
    // 第一次尝试：HEAD（最轻量，大多数站点支持）
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
      headers,
    });
    clearTimeout(timer);

    // 放宽存活判定：能回 2xx/3xx/4xx 都说明服务器在响应
    // 403(WAF/CF 挑战)、405(不支持 HEAD)、429(限流)、501(未实现) 都是"活的"
    // 只有 5xx（服务端错误）和网络层错误才算"可能死了"
    if (res.status < 500) {
      return { ok: true, status: res.status, timeMs: Date.now() - start };
    }
  } catch (err) {
    // HEAD 失败（超时/网络错误），进入 fallback 逻辑
  }

  try {
    // 第二次尝试：GET + Range: bytes=0-0（最小数据量，绕过不支持 HEAD 的服务器）
    // 只对 HEAD 失败的 URL 触发，不增加正常 URL 的开销
    const controller2 = new AbortController();
    const timer2 = setTimeout(() => controller2.abort(), timeoutMs);
    const res2 = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller2.signal,
      headers: { ...headers, Range: "bytes=0-0" },
    });
    clearTimeout(timer2);

    // GET fallback 同样放宽判定
    return {
      ok: res2.status < 500,
      status: res2.status,
      timeMs: Date.now() - start,
    };
  } catch (err2) {
    return {
      ok: false,
      status: 0,
      error: err2.name === "AbortError" ? "timeout" : err2.message,
      timeMs: Date.now() - start,
    };
  }
}

/**
 * 批量检查 URL 健康状态
 * 注意：Workers Free 限制 50 subreq/次，由前端分页调用（每批 ≤45）
 * @param {object} db — D1 数据库实例
 * @param {string[]} urls — URL 数组（≤48）
 * @param {number} [timeoutMs] — 每个 URL 的超时时间
 * @returns {Promise<object>} { ok, total, alive, dead, newDeadUrls, results }
 */
export async function checkBatchHealth(db, urls, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (!Array.isArray(urls) || urls.length === 0) {
    return { ok: false, error: "需要 urls 数组" };
  }

  // 先读取死链接列表（1 次 D1 读取）
  const deadUrls = await getDeadUrls(db);

  // 并发检查所有 URL（≤48 个 fetch = ≤49 subreq，安全在 50 限制内）
  const results = await Promise.all(
    urls.slice(0, 48).map(async (url) => {
      const r = await checkUrlHealth(url, timeoutMs);
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
  };
}
