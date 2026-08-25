// ═══════════════════════════════════════════════════════════════════════════════
// 筛选、排序与匹配
// ═══════════════════════════════════════════════════════════════════════════════

// ── 快捷视图定义 ──────────────────────────────────────────────────────────────
const PRESETS = [
  { key: "",       label: "全部",         icon: "📋" },
  { key: "daily",  label: "今天能签到",   icon: "📅", match: (s) => s.quotaPeriod === "daily" && s.quotaMin > 0 },
  { key: "high",   label: "高额度",       icon: "⭐", match: (s) => s.quotaTier === "high" },
  { key: "image",  label: "免费生图",     icon: "🎨", match: (s) => (s.tags || []).includes("生图") },
  { key: "proxy",  label: "无需魔法",     icon: "🔓", match: (s) => s.needsProxy === 0 },
  { key: "once",   label: "一次性限免",   icon: "🎁", match: (s) => s.quotaPeriod === "once" },
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
      site.register, site.rate, site.quotaRaw, ...(site.tags || []), ...(site.notes || [])
    ].join(" ").toLowerCase();
    if (!haystack.includes(q)) return false;
  }

  // 4. 额度档位（组内 OR）
  if (state.filterTier.length) {
    if (!state.filterTier.includes(site.quotaTier || "none")) return false;
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
    const ts = parseUtc(site.verifiedAt);
    // 解析不出来 = 没有可信的验证时间，按"陈旧"处理而不是放过
    if (Number.isNaN(ts) || Date.now() - ts > FRESH_7D) return false;
  }

  return true;
}

/**
 * 站点的验证时间戳；缺失或无法解析一律算 0（排到最后）
 * 单独抽出来是为了不让 NaN 流进比较器 —— NaN 参与比较会让
 * sort 的结果依赖于原始顺序，表现为"刷新一次顺序就变了"。
 * @param {Object} site
 * @returns {number}
 */
function verifiedTs(site) {
  if (!site.verifiedAt) return 0;
  const ts = parseUtc(site.verifiedAt);
  return Number.isNaN(ts) ? 0 : ts;
}

/**
 * 获取筛选+排序后的站点列表
 * 默认排序：鲜度 desc → 额度档位 asc → 名称 asc
 * 已失效的一律沉到末尾（展示但不占决策位）
 */
function filteredSites() {
  let list = state.sites.filter(matchesFilters);

  switch (state.sortBy) {
    case "fresh":
      list.sort((a, b) => {
        // 有验证时间的排前面
        const aT = verifiedTs(a);
        const bT = verifiedTs(b);
        if (aT !== bT) return bT - aT; // 新的在前
        // 同鲜度按额度档位
        return (TIER_ORDER[a.quotaTier] ?? 3) - (TIER_ORDER[b.quotaTier] ?? 3);
      });
      break;
    case "quota":
      list.sort((a, b) => {
        const aT = TIER_ORDER[a.quotaTier] ?? 3;
        const bT = TIER_ORDER[b.quotaTier] ?? 3;
        if (aT !== bT) return aT - bT; // 高额度在前
        // 同档位内不比 quotaMin：跨单位没有汇率，
        // 100 积分 和 25 刀 的数字大小没有可比性，比了就是误导。
        // 改用与单位无关的鲜度做次级排序。
        return verifiedTs(b) - verifiedTs(a);
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
      list.sort((a, b) => verifiedTs(b) - verifiedTs(a));
  }

  // 已失效的沉底。放在最后单独做一次：Array.prototype.sort 是稳定排序，
  // 所以上面那一轮的相对顺序在各组内不会被打乱。
  list.sort((a, b) => (a.dead ? 1 : 0) - (b.dead ? 1 : 0));

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
    daily: enabled.filter((s) => s.quotaPeriod === "daily" && s.quotaMin > 0).length,
    highTier: enabled.filter((s) => s.quotaTier === "high").length,
    imageGen: enabled.filter((s) => (s.tags || []).includes("生图")).length,
    noProxy: enabled.filter((s) => s.needsProxy === 0).length
  };
}
