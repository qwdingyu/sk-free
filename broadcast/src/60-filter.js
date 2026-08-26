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
 *
 * 注意：这里**不过滤死链**。
 * 死链的呈现方式是"表格底部一个默认折叠的分组"，由 renderTable() 负责，
 * 折叠状态是 state.showDead。曾经这里有一句
 *   if (site.dead && !state.showDead) return false;
 * 结果形成死锁：死链被筛掉 → dead 数组恒为空 → 展开按钮永不渲染 →
 * state.showDead 永远没有入口翻成 true → 死链分组、.row-dead 样式、
 * 沉底排序全部变成不可达代码。用注入 dead=true 的数据实测过：
 * 18 条里 3 条 dead，页面只剩 15 行，连"已失效 (3)"按钮都不存在。
 */
function matchesFilters(site) {
  // 1. 快捷视图
  if (state.activePreset) {
    const preset = PRESETS.find((p) => p.key === state.activePreset);
    if (preset && preset.match && !preset.match(site)) return false;
  }

  // 2. 搜索关键词
  if (state.query) {
    const q = state.query.toLowerCase();
    const haystack = [
      site.name, site.url, site.checkin, site.summary, site.models,
      site.register, site.rate, site.quotaRaw, ...(site.tags || []), ...(site.notes || [])
    ].join(" ").toLowerCase();
    if (!haystack.includes(q)) return false;
  }

  // 3. 额度档位（组内 OR）
  if (state.filterTier.length) {
    if (!state.filterTier.includes(site.quotaTier || "none")) return false;
  }

  // 4. 能力标签（组内 OR）
  if (state.filterCapability.length) {
    const siteCaps = (site.tags || []);
    if (!state.filterCapability.some((c) => siteCaps.includes(c))) return false;
  }

  // 5. 类型（组内 OR）
  if (state.filterKind.length) {
    if (!state.filterKind.includes(site.kind || "api_site")) return false;
  }

  // 6. 门槛（组内 OR）
  if (state.filterThreshold.length) {
    const thresholds = parseThreshold(site.register);
    if (!state.filterThreshold.some((t) => thresholds.includes(t))) return false;
  }

  // 7. 隐藏 7 天未验证
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
 * 当前筛选下"仍然可用"的条数
 * 结果条上的"匹配 N 条"用这个，而不是 filteredSites().length：
 * 死链虽然在列表里，但被折叠在底部分组，把它们算进"匹配"会虚高。
 * @returns {number}
 */
function aliveMatchCount() {
  return filteredSites().filter((s) => !s.dead).length;
}

/**
 * 统计信息（用全量数据计算，不受筛选影响）
 */
function computeStats() {
  const all = state.sites;
  const alive = all.filter((s) => !s.dead);
  return {
    total: all.length,
    dead: all.filter((s) => s.dead).length,
    daily: alive.filter((s) => s.quotaPeriod === "daily" && s.quotaMin > 0).length,
    highTier: alive.filter((s) => s.quotaTier === "high").length,
  };
}
