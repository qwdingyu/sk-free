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
}

/**
 * 渲染三层筛选器
 * 第一层：快捷视图 chips
 * 第二层：搜索 + 精确条件（默认折叠）
 * 第三层：结果条 + 视图切换 + 排序
 */
function renderFilters() {
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
  // 展开状态存在 state 里而不是局部变量：renderFilters() 会 innerHTML=""
  // 重建整条筛选栏，局部变量每次都被重置成"收起"。
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
  const matching = aliveMatchCount();
  resultCount.textContent = `${state.sites.length} 条中匹配 ${matching} 条`;
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
    countEl.textContent = `${state.sites.length} 条中匹配 ${aliveMatchCount()} 条`;
  }
  const clearEl = document.getElementById("clearFiltersBtn");
  if (clearEl) clearEl.hidden = !hasActiveFilters();
}

/** 筛选条件变化后的统一入口：更新计数 + 重渲列表，不重建筛选栏 */
function applyFilterChange() {
  updateResultBar();
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
  return state.activePreset || state.activeTag || state.query
    || state.filterTier.length || state.filterCapability.length
    || state.filterKind.length || state.filterThreshold.length
    || state.hideStale;
}

function clearAllFilters() {
  state.activePreset = "";
  state.activeTag = "";
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
  renderFilters();
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

  // 首屏骨架屏：加载期间显示 6 行占位
  const skeletonRows = Array.from({ length: 6 }, () =>
    '<div class="skeleton-row"><div class="skeleton-cell name"></div><div class="skeleton-cell quota"></div><div class="skeleton-cell cap"></div><div class="skeleton-cell fresh"></div><div class="skeleton-cell action"></div></div>'
  ).join("");
  els.cardsArea.innerHTML = skeletonRows;

  try {
    const data = await loadSites();
    state.metadata = data.metadata || {};
    state.sites = (data.sites || []).filter((s) => s.enabled !== false);

    // 投票数据已内嵌在 sites API 中
    await loadVotes();

    render();
    loadNotice();
  } catch (error) {
    els.cardsArea.innerHTML = `<div class="error-state">数据加载失败：${esc(error.message)}</div>`;
    els.summaryStrip.innerHTML = "";
    els.filterRow.innerHTML = "";
  }
}

// ── 启动 ──────────────────────────────────────────────────────────────────────
init();
