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

/**
 * 加载投票数据
 * 设计：投票数据已内嵌在 sites API 的每条记录中
 * 此函数保留仅为向后兼容，实际不再需要单独请求
 * 站点的 votes 字段直接从 site.votes 读取
 */
async function loadVotes() {
  // 投票数据已包含在 sites API 响应中（site.votes.up/down）
  // 不再需要单独请求 /api/votes
  // 保留此函数签名以兼容 init() 调用
}
