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
  PRESETS.forEach((p) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "preset-btn" + (state.activePreset === p.key ? " is-active" : "");
    btn.textContent = `${p.icon} ${p.label}`;
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
    renderResults();
  }, SEARCH_DEBOUNCE_MS);
  searchInput.addEventListener("input", (e) => debouncedSearch(e.target.value.trim()));
  searchWrap.appendChild(searchInput);
  advancedBar.appendChild(searchWrap);

  // 更多筛选按钮
  const toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.className = "filter-toggle-btn";
  toggleBtn.textContent = "更多筛选 ▾";
  let filterOpen = false;
  const filterPanel = document.createElement("div");
  filterPanel.className = "filter-panel";
  filterPanel.hidden = true;

  toggleBtn.addEventListener("click", () => {
    filterOpen = !filterOpen;
    filterPanel.hidden = !filterOpen;
    toggleBtn.textContent = filterOpen ? "收起筛选 ▴" : "更多筛选 ▾";
  });

  // 额度档位
  filterPanel.appendChild(makeFilterGroup("额度档位", [
    { key: "high", label: "高" },
    { key: "mid", label: "中" },
    { key: "low", label: "低" }
  ], state.filterTier, (vals) => { state.filterTier = vals; syncToUrl(false); renderResults(); }));

  // 类型
  filterPanel.appendChild(makeFilterGroup("类型", [
    { key: "api_site", label: "API站" },
    { key: "bot", label: "机器人" },
    { key: "account_pool", label: "号池" },
    { key: "tool", label: "工具" }
  ], state.filterKind, (vals) => { state.filterKind = vals; syncToUrl(false); renderResults(); }));

  // 门槛
  filterPanel.appendChild(makeFilterGroup("门槛", [
    { key: "GitHub", label: "GitHub" },
    { key: "Telegram", label: "Telegram" },
    { key: "邮箱", label: "邮箱" },
    { key: "无门槛", label: "无门槛" }
  ], state.filterThreshold, (vals) => { state.filterThreshold = vals; syncToUrl(false); renderResults(); }));

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
    renderResults();
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
  const matching = filteredSites().length;
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
    renderResults();
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

  // 清除筛选
  if (hasActiveFilters()) {
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "clear-filters-btn";
    clearBtn.textContent = "清除筛选";
    clearBtn.addEventListener("click", clearAllFilters);
    resultBar.appendChild(clearBtn);
  }

  els.filterRow.append(presetBar, advancedBar, resultBar);
}

/**
 * 构建一组多选筛选器
 */
function makeFilterGroup(label, options, selected, onChange) {
  const group = document.createElement("div");
  group.className = "filter-group";
  const lbl = document.createElement("span");
  lbl.className = "filter-group-label";
  lbl.textContent = label;
  group.appendChild(lbl);

  options.forEach((opt) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "filter-chip" + (selected.includes(opt.key) ? " is-active" : "");
    btn.textContent = opt.label;
    btn.addEventListener("click", () => {
      const idx = selected.indexOf(opt.key);
      if (idx >= 0) selected.splice(idx, 1);
      else selected.push(opt.key);
      onChange([...selected]);
      renderFilters();
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
