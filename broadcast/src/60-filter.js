// ═══════════════════════════════════════════════════════════════════════════════
// 筛选、排序与匹配
// ═══════════════════════════════════════════════════════════════════════════════

// ── 快捷视图定义 ──────────────────────────────────────────────────────────────
const PRESETS = [
  { key: "",       label: "全部",         icon: "📋" },
  { key: "daily",  label: "今天能签到",   icon: "📅", match: (s) => s.quota_period === "daily" && s.quota_min > 0 },
  { key: "high",   label: "高额度",       icon: "⭐", match: (s) => s.quota_tier === "high" },
  { key: "image",  label: "免费生图",     icon: "🎨", match: (s) => (s.tags || []).includes("生图") },
  { key: "proxy",  label: "无需魔法",     icon: "🔓", match: (s) => s.needs_proxy === 0 },
  { key: "once",   label: "一次性限免",   icon: "🎁", match: (s) => s.quota_period === "once" },
  { key: "noauth", label: "无门槛",       icon: "🚪", match: (s) => !s.register || s.register.trim() === "" }
];

/**
 * 单条站点是否匹配当前所有筛选条件（组间 AND，组内 OR）
 */
function matchesFilters(site) {
  // 0. 死链默认折叠（除非管理员展开）
  if (site.dead && !state.showDead) return false;

  // 1. 快捷视图
  if (state.activePreset) {
    const preset = PRESETS.find((p) => p.key === state.activePreset);
    if (preset && preset.match && !preset.match(site)) return false;
  }

  // 2. 标签筛选（来自标签 chips）
  if (state.activeTag) {
    if (!(site.tags || []).includes(state.activeTag)) return false;
  }

  // 3. 搜索关键词
  if (state.query) {
    const q = state.query.toLowerCase();
    const haystack = [
      site.name, site.url, site.checkin, site.summary, site.models,
      site.register, site.rate, site.quota_raw, ...(site.tags || []), ...(site.notes || [])
    ].join(" ").toLowerCase();
    if (!haystack.includes(q)) return false;
  }

  // 4. 额度档位（组内 OR）
  if (state.filterTier.length) {
    if (!state.filterTier.includes(site.quota_tier || "none")) return false;
  }

  // 5. 能力标签（组内 OR）
  if (state.filterCapability.length) {
    const siteCaps = (site.tags || []);
    if (!state.filterCapability.some((c) => siteCaps.includes(c))) return false;
  }

  // 6. 类型（组内 OR）
  if (state.filterKind.length) {
    if (!state.filterKind.includes(site.kind || "api_site")) return false;
  }

  // 7. 门槛（组内 OR）
  if (state.filterThreshold.length) {
    const thresholds = parseThreshold(site.register);
    if (!state.filterThreshold.some((t) => thresholds.includes(t))) return false;
  }

  // 8. 隐藏 7 天未验证
  if (state.hideStale) {
    if (!site.verifiedAt) return false;
    if (Date.now() - new Date(site.verifiedAt).getTime() > FRESH_7D) return false;
  }

  return true;
}

/**
 * 获取筛选+排序后的站点列表
 * 默认排序：鲜度 desc → quota_tier asc → name asc
 */
function filteredSites() {
  let list = state.sites.filter(matchesFilters);

  switch (state.sortBy) {
    case "fresh":
      list.sort((a, b) => {
        // 有验证时间的排前面
        const aT = a.verifiedAt ? new Date(a.verifiedAt).getTime() : 0;
        const bT = b.verifiedAt ? new Date(b.verifiedAt).getTime() : 0;
        if (aT !== bT) return bT - aT; // 新的在前
        // 同鲜度按额度
        return (TIER_ORDER[a.quota_tier] ?? 3) - (TIER_ORDER[b.quota_tier] ?? 3);
      });
      break;
    case "quota":
      list.sort((a, b) => {
        const aT = TIER_ORDER[a.quota_tier] ?? 3;
        const bT = TIER_ORDER[b.quota_tier] ?? 3;
        if (aT !== bT) return aT - bT; // 高额度在前
        return (b.quota_min || 0) - (a.quota_min || 0);
      });
      break;
    case "community":
      list.sort((a, b) => netVotes(b.name) - netVotes(a.name));
      break;
    case "name":
      list.sort((a, b) => (a.name || "").localeCompare(b.name || "", "zh-CN"));
      break;
    default:
      // 默认鲜度
      list.sort((a, b) => {
        const aT = a.verifiedAt ? new Date(a.verifiedAt).getTime() : 0;
        const bT = b.verifiedAt ? new Date(b.verifiedAt).getTime() : 0;
        return bT - aT;
      });
  }

  return list;
}

/**
 * 统计信息（用全量数据计算，不受筛选影响）
 */
function computeStats() {
  const all = state.sites;
  const enabled = all.filter((s) => !s.dead);
  return {
    total: all.length,
    enabled: enabled.length,
    dead: all.filter((s) => s.dead).length,
    daily: enabled.filter((s) => s.quota_period === "daily" && s.quota_min > 0).length,
    highTier: enabled.filter((s) => s.quota_tier === "high").length,
    imageGen: enabled.filter((s) => (s.tags || []).includes("生图")).length,
    noProxy: enabled.filter((s) => s.needs_proxy === 0).length
  };
}
