// ═══════════════════════════════════════════════════════════════════════════════
// API 数据加载
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 加载站点数据（唯一数据源，包含 votes/feedbacks/structured quota）
 * @returns {Promise<{ ok: boolean, sites: Array, metadata: Object }>}
 */
async function loadSites() {
  const res = await fetch("/api/sites?" + CACHE_BUSTER(), { cache: "no-store" });
  if (!res.ok) throw new Error("sites " + res.status);
  const data = await res.json();
  if (!data.ok || !data.sites) throw new Error("sites API 返回异常");
  return data;
}

/**
 * 加载公告（非阻塞，后到后渲染）
 */
async function loadNotice() {
  try {
    const res = await fetch("/api/notice?" + CACHE_BUSTER(), { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      if (data.ok && data.notice) renderNotice(data.notice);
    }
  } catch {
    els.noticeBand.hidden = true;
  }
}
