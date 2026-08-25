// ═══════════════════════════════════════════════════════════════════════════════
// health.js — 链接健康检查 + check-batch 批量检测
// ═══════════════════════════════════════════════════════════════════════════════

import { getDeadUrls } from "./deadurls.js";

// 默认超时时间（毫秒）
const DEFAULT_TIMEOUT_MS = 8000;

/**
 * 检查单个 URL 的健康状态
 * @param {string} url — 目标 URL
 * @param {number} [timeoutMs] — 超时时间（毫秒），默认 8000ms
 * @returns {Promise<{ ok: boolean, status?: number, error?: string, timeMs: number }>}
 */
export async function checkUrlHealth(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; sk-free-health-check/1.0)",
      },
    });
    clearTimeout(timer);
    return {
      ok: res.status >= 200 && res.status < 400,
      status: res.status,
      timeMs: Date.now() - start,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err.name === "AbortError" ? "timeout" : err.message,
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
