// ═══════════════════════════════════════════════════════════════════════════════
// 表格视图（默认视图）
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 渲染对比表格
 * 列：站点 | 每日额度 | 能力 | 门槛 | 鲜度 | 社区 | 操作
 */
function renderTable() {
  const visible = filteredSites();
  const stats = computeStats();

  if (!visible.length) {
    els.cardsArea.innerHTML = '<div class="empty-state">没有匹配的站点。</div>';
    return;
  }

  // 按 dead 状态分组：活的在前，死链在后
  const alive = visible.filter((s) => !s.dead);
  const dead = visible.filter((s) => s.dead);

  const table = document.createElement("table");
  table.className = "site-table";
  table.setAttribute("role", "grid");
  table.setAttribute("aria-label", "站点对比表");

  // ── 表头（aria-sort 标记当前排序列）─────────────────────────────────────────
  const sortColMap = { fresh: "col-fresh", quota: "col-quota", community: "col-community", name: "col-name" };
  const activeSortCol = sortColMap[state.sortBy] || "col-fresh";
  const th = (cls, label) => `<th scope="col" class="${cls}" aria-sort="${cls === activeSortCol ? "descending" : "none"}">${label}</th>`;
  const thead = document.createElement("thead");
  thead.innerHTML = `<tr>
    ${th("col-name", "站点")}
    ${th("col-quota", "每日额度")}
    ${th("col-cap", "能力")}
    ${th("col-threshold", "门槛")}
    ${th("col-fresh", "鲜度")}
    ${th("col-community", "社区")}
    <th scope="col" class="col-action" aria-sort="none">操作</th>
  </tr>`;
  table.appendChild(thead);

  // ── 表体 ────────────────────────────────────────────────────────────────────
  const tbody = document.createElement("tbody");
  alive.forEach((site) => tbody.appendChild(makeTableRow(site)));

  // 死链分组（默认折叠）
  if (dead.length) {
    const deadGroup = document.createElement("tbody");
    deadGroup.className = "dead-group";
    deadGroup.hidden = !state.showDead;

    const toggleRow = document.createElement("tr");
    toggleRow.className = "dead-toggle";
    toggleRow.innerHTML = `<td colspan="7">
      <button class="dead-toggle-btn" aria-expanded="false">
        已失效 (${dead.length}) — 点击展开
      </button>
    </td>`;
    toggleRow.querySelector("button").addEventListener("click", (e) => {
      state.showDead = !state.showDead;
      deadGroup.hidden = !state.showDead;
      e.currentTarget.setAttribute("aria-expanded", String(state.showDead));
      e.currentTarget.textContent = state.showDead
        ? `已失效 (${dead.length}) — 点击折叠`
        : `已失效 (${dead.length}) — 点击展开`;
    });
    tbody.appendChild(toggleRow);

    dead.forEach((site) => {
      const row = makeTableRow(site);
      row.classList.add("row-dead");
      deadGroup.appendChild(row);
    });
    tbody.appendChild(deadGroup);
  }

  table.appendChild(tbody);
  els.cardsArea.replaceChildren(table);
}

/**
 * 构建单行表格行
 */
function makeTableRow(site) {
  const row = document.createElement("tr");
  row.dataset.siteName = site.name;

  // ── 站点列：名称 + kind 徽章 + 🔒 需魔法 ──────────────────────────────────
  const kindInfo = KIND_BADGE[site.kind] || KIND_BADGE.api_site;
  const proxyIcon = site.needsProxy ? ' <span class="proxy-icon" title="需要代理/魔法">🔒</span>' : "";
  const deadCls = site.dead ? " cell-dead" : "";
  const nameHtml = `<div class="cell-name${deadCls}">
    <span class="site-name">${esc(site.name)}</span>
    <span class="kind-badge">${kindInfo.icon ? kindInfo.icon + " " : ""}${kindInfo.label}</span>
    ${proxyIcon}
  </div>`;

  // ── 额度列 ──────────────────────────────────────────────────────────────────
  const tierLabel = { high: "高额度", mid: "中额度", low: "低额度", none: "" };
  const tierCls = site.quotaTier === "high" ? " tier-high"
    : site.quotaTier === "mid" ? " tier-mid"
    : site.quotaTier === "low" ? " tier-low" : "";
  const callsEst = site.quotaCallsEst ? `<span class="calls-est">≈${site.quotaCallsEst}次调用</span>` : "";
  const quotaHtml = `<div class="cell-quota${tierCls}">
    <span class="quota-main">${esc(quotaText(site))}</span>
    ${tierLabel[site.quotaTier] ? `<span class="tier-badge">${tierLabel[site.quotaTier]}</span>` : ""}
    ${callsEst}
    ${site.quotaRaw ? `<span class="quota-raw" title="${esc(site.quotaRaw)}">ℹ️</span>` : ""}
  </div>`;

  // ── 能力列（只显示真实存在的标签）───────────────────────────────────────────
  const caps = (site.tags || []).filter((t) => ["生图", "限免"].includes(t));
  const capHtml = caps.length
    ? `<div class="cell-cap">${caps.map((c) => `<span class="tag ${TAG_CLASS[c] || ""}">${esc(c)}</span>`).join("")}</div>`
    : '<div class="cell-cap dim">—</div>';

  // ── 门槛列 ──────────────────────────────────────────────────────────────────
  const thresholds = parseThreshold(site.register);
  const thHtml = thresholds.length
    ? `<div class="cell-threshold">${thresholds.map((t) => `<span class="threshold-tag">${esc(t)}</span>`).join(" ")}</div>`
    : '<div class="cell-threshold dim">—</div>';

  // ── 鲜度列 ──────────────────────────────────────────────────────────────────
  const fresh = freshnessLevel(site.verifiedAt);
  const freshHtml = `<div class="cell-fresh ${fresh.cls}">
    <span class="fresh-dot"></span>
    <span class="fresh-label">${esc(fresh.label)}</span>
  </div>`;

  // ── 社区列 ──────────────────────────────────────────────────────────────────
  const score = netVotes(site.name);
  const scoreStr = score > 0 ? `+${score}` : String(score);
  const scoreCls = score > 0 ? " positive" : score < 0 ? " negative" : "";
  const communityHtml = `<div class="cell-community">
    <span class="vote-score-inline${scoreCls}">${scoreStr}</span>
  </div>`;

  // ── 操作列 ──────────────────────────────────────────────────────────────────
  const actionHtml = `<div class="cell-action">
    <a href="${esc(site.url)}" target="_blank" rel="noopener" class="btn-visit" aria-label="访问 ${esc(site.name)}">访问 →</a>
    <button class="btn-detail" data-site="${esc(site.name)}" aria-label="查看详情">⋯</button>
    <button class="btn-still-works" data-site="${esc(site.name)}" aria-label="标记还能用">👍</button>
    <button class="btn-reported-dead" data-site="${esc(site.name)}" aria-label="标记已失效">👎</button>
  </div>`;

  row.innerHTML = nameHtml + quotaHtml + capHtml + thHtml + freshHtml + communityHtml + actionHtml;

  // ── 事件绑定 ────────────────────────────────────────────────────────────────
  row.querySelector(".btn-detail")?.addEventListener("click", () => openDrawer(site));
  row.querySelector(".btn-still-works")?.addEventListener("click", () => quickFeedback(site.name, "still_works"));
  row.querySelector(".btn-reported-dead")?.addEventListener("click", () => quickFeedback(site.name, "reported_dead"));

  return row;
}

/**
 * HTML 转义（防 XSS）
 */
function esc(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
