/**
 * 共享 API 封装
 * 广播页面和管理后台共用
 */

const API_BASE = "";

export async function api(path, opts = {}) {
  const res = await fetch(API_BASE + path, {
    headers: {
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
    ...opts,
  });
  if (!res.ok) {
    const text = await res.text();
    let msg = text;
    try { msg = JSON.parse(text).error || text; } catch {}
    throw new Error(msg || `HTTP ${res.status}`);
  }
  return res.json();
}

export { api as default };
