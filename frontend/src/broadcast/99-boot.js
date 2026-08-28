// ═══════════════════════════════════════════════════════════════════════════════
// 初始化 + 三层筛选 UI + 主渲染管线
// ═══════════════════════════════════════════════════════════════════════════════

// ── 公告渲染 ──────────────────────────────────────────────────────────────────

function renderNotice(markdown) {
  const text = markdown.trim();
  if (!text) return;
  const paragraphs = text.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean).slice(0, 3);
  els.noticeContent.replaceChildren(
    ...paragraphs.map((block) => {
      const p = document.createElement("p");
      p.textContent = block.replace(/\n/g, " ");
      return p;
    })
  );
  els.noticeBand.hidden = false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 三层筛选 UI 渲染
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 渲染摘要统计条（全量数据，不受筛选影响）
 */
function renderSummary() {
  const stats = computeStats();
  const items = [
    ["收录", stats.total],
    ["可签到", stats.daily],
    ["高额度", stats.highTier],
    ["已失效", stats.dead]
  ];

  els.summaryStrip.replaceChildren(
    ...items.map(([label, value]) => {
      const item = document.createElement("div");
      item.className = "summary-item";
      const strong = document.createElement("strong");
      strong.textContent = String(value);
      const span = document.createElement("span");
      span.textContent = label;
      item.append(strong, span);
      return item;
    })
  );

  // 鲜度分布 + 图例
  renderFreshnessBar();
}

/**
 * 鲜度分布迷你条 + 图例（护城河信号）
 * 用现有 freshnessLevel 计算，不新增字段/接口。
 */
function renderFreshnessBar() {
  const alive = state.sites.filter((s) => !s.dead);
  const now = Date.now();
  let fresh24h = 0, fresh7d = 0, stale = 0, unknown = 0;
  alive.forEach((s) => {
    if (!s.verifiedAt) { unknown++; return; }
    const ts = parseUtc(s.verifiedAt);
    if (isNaN(ts)) { unknown++; return; }
    const diff = now - ts;
    if (diff <= FRESH_24H) fresh24h++;
    else if (diff <= FRESH_7D) fresh7d++;
    else stale++;
  });
  const total = alive.length;
  const pct = (n) => total > 0 ? Math.round(n / total * 100) : 0;

  // 复用 summaryStrip 后面的空间，追加一行鲜度条
  let bar = document.getElementById("freshnessBar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "freshnessBar";
    bar.className = "freshness-bar";
    els.summaryStrip.after(bar);
  }
  bar.innerHTML = `
    <div class="freshness-track" role="img" aria-label="鲜度分布：24小时内 ${fresh24h}，7天内 ${fresh7d}，陈旧 ${stale}，未验证 ${unknown}">
      <span class="freshness-seg seg-fresh" style="flex:${fresh24h || 0.1}" title="24h 内验证：${fresh24h} 个"></span>
      <span class="freshness-seg seg-ok" style="flex:${fresh7d || 0.1}" title="7 天内验证：${fresh7d} 个"></span>
      <span class="freshness-seg seg-stale" style="flex:${stale || 0.1}" title="超过 7 天未验证：${stale} 个"></span>
      <span class="freshness-seg seg-unknown" style="flex:${unknown || 0.1}" title="从未验证：${unknown} 个"></span>
    </div>
    <div class="freshness-legend">
      <span><span class="dot dot-fresh"></span> 24h内：${fresh24h}（${pct(fresh24h)}%）</span>
      <span><span class="dot dot-ok"></span> 7天内：${fresh7d}（${pct(fresh7d)}%）</span>
      <span><span class="dot dot-stale"></span> 陈旧：${stale}（${pct(stale)}%）</span>
      <span><span class="dot dot-unknown"></span> 未验证：${unknown}（${pct(unknown)}%）</span>
      <span class="freshness-note">数据每 6 小时自动验证 · 死链每日标记</span>
    </div>`;
}

/**
 * 今日可信速览：基于鲜度 + 额度的前 3 个站点，放在筛选栏之前，
 * 让首屏立刻建立"今天还能信哪个、哪个额度最大"的信任与方向感。
 * 不新增字段/接口，纯前端计算。
 */
function renderTrustedStrip() {
  const strip = document.getElementById("trustedStrip");
  if (!strip) return;

  const now = Date.now();
  const candidates = state.sites
    .filter((s) => !s.dead && s.enabled && s.verifiedAt)
    .map((s) => {
      const ts = parseUtc(s.verifiedAt);
      if (isNaN(ts)) return null;
      const ageHours = (now - ts) / (1000 * 60 * 60);
      // 鲜度分：0h=100，100h+=0；额度分：直接用数值（不同单位无法精确换算，
      // 但同一站点列表内仍有可比性，且鲜度权重更高）
      const freshnessScore = Math.max(0, 100 - ageHours);
      const q = s.quotaMax != null ? s.quotaMax : (s.quotaCallsEst != null ? s.quotaCallsEst : 0);
      const quotaScore = typeof q === "number" ? q : 0;
      return { s, score: freshnessScore * 2 + quotaScore };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  if (candidates.length === 0) {
    strip.innerHTML = '<div class="trusted-empty">今日暂无已验证的高额度站点</div>';
    return;
  }

  strip.innerHTML = `
    <div class="trusted-header">
      <h2>今日可信速览</h2>
      <span class="trusted-sub">基于鲜度 + 额度综合排序</span>
    </div>
    <div class="trusted-cards">
      ${candidates.map(({ s }) => {
        const ts = parseUtc(s.verifiedAt);
        const diff = now - ts;
        let freshCls = "is-stale";
        let freshLabel = "已验证";
        if (diff <= FRESH_24H) { freshCls = "is-fresh"; freshLabel = "24h 内验证"; }
        else if (diff <= FRESH_7D) { freshCls = "is-ok"; freshLabel = "7 天内验证"; }
        return `
          <a href="${esc(s.url)}" target="_blank" rel="noopener" class="trusted-card">
            <div class="trusted-name" title="${esc(s.name)}">${esc(s.name)}</div>
            <div class="trusted-meta">
              <span class="trusted-freshness ${freshCls}">${freshLabel}</span>
              <span class="trusted-quota">${esc(quotaText(s))}</span>
            </div>
          </a>
        `;
      }).join("")}
    </div>
  `;
}

/**
 * 渲染三层筛选器
 * 第一层：快捷视图 chips
 * 第二层：搜索 + 精确条件（默认折叠）
 * 第三层：结果条 + 视图切换 + 排序
 */
function buildFilterBar() {
  els.filterRow.innerHTML = "";

  // ── 第一层：快捷视图 chips ──────────────────────────────────────────────────
  const presetBar = document.createElement("div");
  presetBar.className = "preset-bar";
  presetBar.setAttribute("role", "group");
  presetBar.setAttribute("aria-label", "快捷视图");
  PRESETS.forEach((p) => {
    const btn = document.createElement("button");
    btn.type = "button";
    const isActive = state.activePreset === p.key;
    btn.className = "preset-btn" + (isActive ? " is-active" : "");
    btn.textContent = `${p.icon} ${p.label}`;
    btn.setAttribute("aria-pressed", String(isActive));
    btn.addEventListener("click", () => {
      state.activePreset = state.activePreset === p.key ? "" : p.key;
      syncToUrl(true);
      render();
    });
    presetBar.appendChild(btn);
  });

  // ── 第二层：搜索 + 精确条件 ─────────────────────────────────────────────────
  const advancedBar = document.createElement("div");
  advancedBar.className = "advanced-bar";

  // 搜索框
  const searchWrap = document.createElement("div");
  searchWrap.className = "search-wrap";
  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.id = "searchInput";
  searchInput.className = "search-input";
  searchInput.placeholder = "搜索站点名、模型、额度...";
  searchInput.value = state.query;
  searchInput.setAttribute("aria-label", "搜索站点");
  const debouncedSearch = debounce((val) => {
    state.query = val;
    syncToUrl(false);
    applyFilterChange();
  }, SEARCH_DEBOUNCE_MS);
  searchInput.addEventListener("input", (e) => debouncedSearch(e.target.value.trim()));
  searchWrap.appendChild(searchInput);
  advancedBar.appendChild(searchWrap);

  // 更多筛选按钮
  const toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.className = "filter-toggle-btn";
  // 展开状态存在 state 里而不是局部变量：buildFilterBar() 只在初始化时调用一次，
  // 后续由 updateFilterUI() 原地更新，不会再被 innerHTML="" 重置。
  toggleBtn.textContent = state.filterPanelOpen ? "收起筛选 ▴" : "更多筛选 ▾";
  toggleBtn.setAttribute("aria-expanded", String(state.filterPanelOpen));
  toggleBtn.setAttribute("aria-controls", "filterPanel");
  const filterPanel = document.createElement("div");
  filterPanel.className = "filter-panel";
  filterPanel.id = "filterPanel";
  filterPanel.hidden = !state.filterPanelOpen;

  toggleBtn.addEventListener("click", () => {
    state.filterPanelOpen = !state.filterPanelOpen;
    filterPanel.hidden = !state.filterPanelOpen;
    toggleBtn.textContent = state.filterPanelOpen ? "收起筛选 ▴" : "更多筛选 ▾";
    toggleBtn.setAttribute("aria-expanded", String(state.filterPanelOpen));
  });

  // 额度档位
  filterPanel.appendChild(makeFilterGroup("额度档位", [
    { key: "high", label: "高" },
    { key: "mid", label: "中" },
    { key: "low", label: "低" }
  ], state.filterTier, (vals) => { state.filterTier = vals; syncToUrl(false); applyFilterChange(); }));

  // 类型
  filterPanel.appendChild(makeFilterGroup("类型", [
    { key: "api_site", label: "API站" },
    { key: "bot", label: "机器人" },
    { key: "account_pool", label: "号池" },
    { key: "tool", label: "工具" }
  ], state.filterKind, (vals) => { state.filterKind = vals; syncToUrl(false); applyFilterChange(); }));

  // 能力标签（生图/限免 — 由站点 tags 决定，与 filterCapability 状态联动）
  filterPanel.appendChild(makeFilterGroup("能力", [
    { key: "生图", label: "生图" },
    { key: "限免", label: "限免" }
  ], state.filterCapability, (vals) => { state.filterCapability = vals; syncToUrl(false); applyFilterChange(); }));

  // 门槛
  filterPanel.appendChild(makeFilterGroup("门槛", [
    { key: "GitHub", label: "GitHub" },
    { key: "Telegram", label: "Telegram" },
    { key: "邮箱", label: "邮箱" },
    { key: "无门槛", label: "无门槛" }
  ], state.filterThreshold, (vals) => { state.filterThreshold = vals; syncToUrl(false); applyFilterChange(); }));

  // 隐藏过期
  const staleRow = document.createElement("div");
  staleRow.className = "filter-row-item";
  const staleCheck = document.createElement("input");
  staleCheck.type = "checkbox";
  staleCheck.id = "hideStale";
  staleCheck.checked = state.hideStale;
  const staleLabel = document.createElement("label");
  staleLabel.htmlFor = "hideStale";
  staleLabel.textContent = "隐藏 7 天未验证";
  staleCheck.addEventListener("change", (e) => {
    state.hideStale = e.target.checked;
    syncToUrl(false);
    applyFilterChange();
  });
  staleRow.append(staleCheck, staleLabel);
  filterPanel.appendChild(staleRow);

  advancedBar.append(toggleBtn, filterPanel);

  // ── 第三层：结果条 + 视图切换 + 排序 ───────────────────────────────────────
  const resultBar = document.createElement("div");
  resultBar.className = "result-bar";
  resultBar.setAttribute("aria-live", "polite");

  const resultCount = document.createElement("span");
  resultCount.className = "result-count";
  resultCount.id = "resultCount";
  const filtered = filteredSites();
  resultCount.textContent = `${filtered.length} 条中匹配 ${aliveMatchCount(filtered)} 条`;
  resultBar.appendChild(resultCount);

  // 排序选择
  const sortWrap = document.createElement("span");
  sortWrap.className = "sort-wrap";
  const sortLabel = document.createElement("span");
  sortLabel.className = "sort-label";
  sortLabel.textContent = "排序";
  const sortSelect = document.createElement("select");
  sortSelect.className = "sort-select";
  sortSelect.setAttribute("aria-label", "排序方式");
  SORT_OPTIONS.forEach((opt) => {
    const option = document.createElement("option");
    option.value = opt.value;
    option.textContent = opt.label;
    option.selected = opt.value === state.sortBy;
    sortSelect.appendChild(option);
  });
  sortSelect.addEventListener("change", (e) => {
    state.sortBy = e.target.value;
    syncToUrl(false);
    applyFilterChange();
  });
  sortWrap.append(sortLabel, sortSelect);
  resultBar.appendChild(sortWrap);

  // 视图切换
  const viewWrap = document.createElement("span");
  viewWrap.className = "view-wrap";
  const tableBtn = document.createElement("button");
  tableBtn.type = "button";
  tableBtn.className = "view-btn" + (state.viewMode === "table" ? " is-active" : "");
  tableBtn.textContent = "表格";
  tableBtn.addEventListener("click", () => { state.viewMode = "table"; syncToUrl(false); render(); });
  const cardBtn = document.createElement("button");
  cardBtn.type = "button";
  cardBtn.className = "view-btn" + (state.viewMode === "card" ? " is-active" : "");
  cardBtn.textContent = "卡片";
  cardBtn.addEventListener("click", () => { state.viewMode = "card"; syncToUrl(false); render(); });
  viewWrap.append(tableBtn, cardBtn);
  resultBar.appendChild(viewWrap);

  // 清除筛选（常驻元素，用 hidden 控制显隐，便于原地更新而不重建整条筛选栏）
  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.id = "clearFiltersBtn";
  clearBtn.className = "clear-filters-btn";
  clearBtn.textContent = "清除筛选";
  clearBtn.hidden = !hasActiveFilters();
  clearBtn.addEventListener("click", clearAllFilters);
  resultBar.appendChild(clearBtn);

  // 存储关键元素引用，供 updateFilterUI() 原地更新，避免重建整条筛选栏
  state._filterEls = {
    presetBtns: [...presetBar.querySelectorAll(".preset-btn")],
    tableBtn,
    cardBtn,
    sortSelect,
    resultCount,
    clearBtn,
    toggleBtn,
    filterPanel,
  };

  els.filterRow.append(presetBar, advancedBar, resultBar);
}

/**
 * 原地更新"匹配 N 条"和"清除筛选"按钮
 *
 * 为什么需要它：筛选交互原本调 renderResults()，而结果计数是在
 * renderFilters() 里算的 —— 于是搜索、排序、档位、门槛、隐藏过期
 * 这些操作全都不会刷新计数，列表明明只剩 1 条，上面还写着"匹配 18 条"。
 * 而如果改成调 renderFilters()，整条筛选栏会被重建：
 * 搜索框失去焦点、"更多筛选"面板被关掉。
 * 所以拆出这个只改文字和显隐的轻量函数。
 */
function updateResultBar() {
  const countEl = document.getElementById("resultCount");
  if (countEl) {
    const filtered = filteredSites();
    countEl.textContent = `${filtered.length} 条中匹配 ${aliveMatchCount(filtered)} 条`;
  }
  const clearEl = document.getElementById("clearFiltersBtn");
  if (clearEl) clearEl.hidden = !hasActiveFilters();
}

/**
 * 原地更新筛选栏的交互状态（快捷视图 / 视图切换 / 排序 / 结果计数），
 * 不重建 DOM，因此搜索框不会失焦、"更多筛选"面板不会意外收起。
 *
 * 与 updateResultBar() 的区别：updateResultBar() 只改文字和 hidden，
 * 本函数还同步按钮 active 状态、排序 value、面板展开状态。
 */
function updateFilterUI() {
  const f = state._filterEls;
  if (!f) return;

  // 快捷视图 chips
  if (f.presetBtns && f.presetBtns.length) {
    f.presetBtns.forEach((btn, i) => {
      const p = PRESETS[i];
      if (!p) return;
      const isActive = state.activePreset === p.key;
      btn.classList.toggle("is-active", isActive);
      btn.setAttribute("aria-pressed", String(isActive));
    });
  }

  // 视图切换
  if (f.tableBtn) f.tableBtn.classList.toggle("is-active", state.viewMode === "table");
  if (f.cardBtn) f.cardBtn.classList.toggle("is-active", state.viewMode === "card");

  // 排序
  if (f.sortSelect) f.sortSelect.value = state.sortBy;

  // 结果计数 + 清除按钮
  updateResultBar();

  // 更多筛选面板
  if (f.toggleBtn) {
    f.toggleBtn.textContent = state.filterPanelOpen ? "收起筛选 ▴" : "更多筛选 ▾";
    f.toggleBtn.setAttribute("aria-expanded", String(state.filterPanelOpen));
  }
  if (f.filterPanel) f.filterPanel.hidden = !state.filterPanelOpen;
}

/** 筛选条件变化后的统一入口：更新计数 + 重渲列表，不重建筛选栏 */
function applyFilterChange() {
  updateFilterUI();
  renderResults();
}

/**
 * 构建一组多选筛选器
 */
function makeFilterGroup(label, options, selected, onChange) {
  const group = document.createElement("div");
  group.className = "filter-group";
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", label);
  const lbl = document.createElement("span");
  lbl.className = "filter-group-label";
  lbl.textContent = label;
  group.appendChild(lbl);

  options.forEach((opt) => {
    const btn = document.createElement("button");
    btn.type = "button";
    const isActive = selected.includes(opt.key);
    btn.className = "filter-chip" + (isActive ? " is-active" : "");
    btn.textContent = opt.label;
    btn.setAttribute("aria-pressed", String(isActive));
    btn.addEventListener("click", () => {
      const idx = selected.indexOf(opt.key);
      if (idx >= 0) selected.splice(idx, 1);
      else selected.push(opt.key);
      // 只更新这一个按钮自己的状态，不再调 renderFilters()。
      // 原来那样会 innerHTML="" 重建整条筛选栏，而"更多筛选"面板的
      // 展开状态是 renderFilters() 里的局部变量 —— 于是点一次筛选项
      // 面板就自动收起，多选组实际没法多选。
      const nowActive = selected.includes(opt.key);
      btn.classList.toggle("is-active", nowActive);
      btn.setAttribute("aria-pressed", String(nowActive));
      onChange([...selected]);
    });
    group.appendChild(btn);
  });

  return group;
}

function hasActiveFilters() {
  return state.activePreset || state.query
    || state.filterTier.length || state.filterCapability.length
    || state.filterKind.length || state.filterThreshold.length
    || state.hideStale;
}

function clearAllFilters() {
  state.activePreset = "";
  state.query = "";
  state.filterTier = [];
  state.filterCapability = [];
  state.filterKind = [];
  state.filterThreshold = [];
  state.hideStale = false;
  syncToUrl(true);
  render();
}

// ═══════════════════════════════════════════════════════════════════════════════
// 主渲染管线
// ═══════════════════════════════════════════════════════════════════════════════

function renderResults() {
  if (state.viewMode === "table") renderTable();
  else renderCards();
}

function render() {
  renderSummary();
  renderTrustedStrip();
  updateFilterUI();
  renderResults();
}

// ═══════════════════════════════════════════════════════════════════════════════
// 初始化
// ═══════════════════════════════════════════════════════════════════════════════

async function init() {
  initDom();
  syncFromUrl();
  initTheme();
  initSubmitForm();
  initFeedbackForm();

  // Hero 主 CTA：点击"查看高额度"→ 应用 high 预设并滚动到列表
  const heroPresetBtn = document.getElementById("heroPresetBtn");
  if (heroPresetBtn) {
    heroPresetBtn.addEventListener("click", () => {
      state.activePreset = "high";
      state.query = "";
      var si = document.getElementById("searchInput");
      if (si) si.value = "";
      syncToUrl(false);
      applyFilterChange();
      document.getElementById("cardsArea")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  // 首屏骨架屏：加载期间显示占位，按当前视图模式渲染对应形态
  // 表格视图用 <table> 骨架（与真实表格同构），卡片视图用 flex 行骨架。
  // 之前统一用 flex 行骨架，表格视图下首屏会先闪一排"卡片"再跳成表格，
  // 视觉上像布局错乱。这里按 state.viewMode 区分。
  if (state.viewMode === "table") {
    const skeletonTable = `
      <table class="site-table skeleton-table" aria-hidden="true">
        <thead><tr>
          <th class="col-name">站点</th>
          <th class="col-quota">每日额度</th>
          <th class="col-cap">能力</th>
          <th class="col-threshold">门槛</th>
          <th class="col-fresh">鲜度</th>
          <th class="col-community">社区</th>
          <th class="col-action">操作</th>
        </tr></thead>
        <tbody>
          ${Array.from({ length: 6 }, () => `
            <tr>
              <td class="col-name"><div class="skeleton-cell name"></div></td>
              <td class="col-quota"><div class="skeleton-cell quota"></div></td>
              <td class="col-cap"><div class="skeleton-cell cap"></div></td>
              <td class="col-threshold"><div class="skeleton-cell threshold"></div></td>
              <td class="col-fresh"><div class="skeleton-cell fresh"></div></td>
              <td class="col-community"><div class="skeleton-cell community"></div></td>
              <td class="col-action"><div class="skeleton-cell action"></div></td>
            </tr>`).join("")}
        </tbody>
      </table>`;
    els.cardsArea.innerHTML = skeletonTable;
  } else {
    // 卡片视图骨架：flex 行，每行模拟一个卡片的关键信息占位
    const skeletonRows = Array.from({ length: 6 }, () =>
      '<div class="skeleton-row"><div class="skeleton-cell name"></div><div class="skeleton-cell quota"></div><div class="skeleton-cell cap"></div><div class="skeleton-cell fresh"></div><div class="skeleton-cell action"></div></div>'
    ).join("");
    els.cardsArea.innerHTML = skeletonRows;
  }

  try {
    const data = await loadSites();
    state.metadata = data.metadata || {};
    // 后端契约：/api/sites 返回全量站点（含停用），dead := enabled!==1。
    // 此处曾有 filter(s => s.enabled !== false)，会把死链整行丢弃——
    // 导致「已失效」折叠组永不出现、摘要条的收录/已失效计数失真
    // （真实数据下显示 37/0 而非 68/31）。展示策略归 60-filter 的
    // showDead 开关与 70-view 的分组，这里不做数据裁剪。
    state.sites = data.sites || [];
    // 后端 /api/sites 已把 votes 映射进每个 site 对象（sites.js:223/261），
    // 但前端之前只在用户投票后才往 state.votes 写一条 —— 导致首屏社区列全显示 0。
    // 此处把后端返回的总票数灌入 state.votes，保证首屏就有真实社区评分。
    state.sites.forEach((s) => {
      if (s.votes) state.votes[s.name] = { up: s.votes.up || 0, down: s.votes.down || 0 };
    });

    // 初始化筛选栏（只构建一次，后续由 updateFilterUI() 原地更新状态）
    buildFilterBar();

    render();
    loadNotice();
  } catch (error) {
    els.cardsArea.innerHTML = `<div class="error-state">数据加载失败：${esc(error.message)}</div>`;
    els.summaryStrip.innerHTML = "";
    els.filterRow.innerHTML = "";
  }
}

// ── 启动 ──────────────────────────────────────────────────────────────────────
// init() 由 main.js 在 DOMContentLoaded 时调用，避免重复初始化
document.addEventListener("DOMContentLoaded", init);
