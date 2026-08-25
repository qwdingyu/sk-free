// ═══════════════════════════════════════════════════════════════════════════════
// 卡片视图 + 详情抽屉
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 渲染卡片网格视图（移动端默认 / 可切换）
 */
function renderCards() {
  const visible = filteredSites();

  if (!visible.length) {
    els.cardsArea.innerHTML = '<div class="empty-state">没有匹配的站点。</div>';
    return;
  }

  const grid = document.createElement("div");
  grid.className = "card-grid";
  visible.forEach((site) => grid.appendChild(makeCard(site)));
  els.cardsArea.replaceChildren(grid);
}

/**
 * 构建单张站点卡片（L1 决策层）
 * 只放高填充率字段：name / quota / summary / 3 个决策标记 / 操作按钮
 * 低填充率字段（models/register/rate/notes）下沉到详情抽屉
 */
function makeCard(site) {
  const node = document.createElement("div");
  node.className = "site-card" + (site.dead ? " card-dead" : "");
  node.dataset.siteName = site.name;

  // ── 鲜度标记 ────────────────────────────────────────────────────────────────
  const fresh = freshnessLevel(site.verifiedAt);
  const kindInfo = KIND_BADGE[site.kind] || KIND_BADGE.api_site;
  const proxyIcon = site.needsProxy ? ' <span class="proxy-icon" title="需要代理">🔒</span>' : "";

  // ── 卡片头部：名称 + 类型 + 鲜度 ──────────────────────────────────────────
  const header = document.createElement("div");
  header.className = "card-header";
  header.innerHTML = `
    <div class="card-title-row">
      <h2 class="card-name">${esc(site.name)}</h2>
      <span class="kind-badge">${kindInfo.icon ? kindInfo.icon + " " : ""}${esc(kindInfo.label)}</span>
      ${proxyIcon}
    </div>
    <div class="card-fresh ${fresh.cls}">
      <span class="fresh-dot"></span>
      <span class="fresh-label">${esc(fresh.label)}</span>
    </div>
  `;

  // ── 额度（唯一的大号数字）─────────────────────────────────────────────────
  const quota = document.createElement("div");
  quota.className = "card-quota";
  const tierLabel = { high: "⭐高额度", mid: "中额度", low: "低额度", none: "" };
  quota.innerHTML = `
    <span class="quota-main">${esc(quotaText(site))}</span>
    ${tierLabel[site.quotaTier] ? `<span class="tier-badge">${esc(tierLabel[site.quotaTier])}</span>` : ""}
  `;

  // ── Summary（2 行截断）─────────────────────────────────────────────────────
  const summary = document.createElement("div");
  summary.className = "card-summary";
  summary.textContent = site.summary || "";
  summary.title = site.summary || "";

  // ── 3 个决策标记（能力 + 门槛）─────────────────────────────────────────────
  const markers = document.createElement("div");
  markers.className = "card-markers";
  const caps = (site.tags || []).filter((t) => ["生图", "限免"].includes(t));
  caps.forEach((c) => {
    const tag = document.createElement("span");
    tag.className = `tag ${TAG_CLASS[c] || ""}`;
    tag.textContent = c;
    markers.appendChild(tag);
  });
  if (site.needsProxy === 0) {
    const proxy = document.createElement("span");
    proxy.className = "marker-proxy";
    proxy.textContent = "🔓无需魔法";
    markers.appendChild(proxy);
  }
  const thresholds = parseThreshold(site.register);
  if (thresholds.length && thresholds[0] !== "无门槛") {
    const th = document.createElement("span");
    th.className = "marker-threshold";
    th.textContent = thresholds.join("/");
    markers.appendChild(th);
  }

  // ── 操作按钮行 ──────────────────────────────────────────────────────────────
  const actions = document.createElement("div");
  actions.className = "card-actions";
  const visitLink = document.createElement("a");
  visitLink.href = site.url;
  visitLink.target = "_blank";
  visitLink.rel = "noopener";
  visitLink.className = "btn-visit";
  visitLink.textContent = "访问站点 →";

  const detailBtn = document.createElement("button");
  detailBtn.type = "button";
  detailBtn.className = "btn-detail";
  detailBtn.textContent = "⋯ 详情";
  detailBtn.addEventListener("click", () => openDrawer(site));

  const voteBar = makeVoteBar(site.name);
  actions.append(visitLink, detailBtn, voteBar);

  // ── 组装 ────────────────────────────────────────────────────────────────────
  node.append(header, quota, summary, markers, actions);
  return node;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 详情抽屉（L2 — 点"⋯详情"滑出，不跳页）
// ═══════════════════════════════════════════════════════════════════════════════

function openDrawer(site) {
  state.drawerSite = site;
  // 记录触发元素，关闭时恢复焦点（a11y）
  const triggerEl = document.activeElement;
  const existing = document.querySelector(".drawer-overlay");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.className = "drawer-overlay";
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeDrawer(triggerEl);
  });

  const drawer = document.createElement("div");
  drawer.className = "drawer";
  drawer.setAttribute("role", "dialog");
  drawer.setAttribute("aria-modal", "true");

  // 关闭按钮
  const closeBtn = document.createElement("button");
  closeBtn.className = "drawer-close";
  closeBtn.textContent = "✕";
  closeBtn.setAttribute("aria-label", "关闭详情");
  closeBtn.addEventListener("click", () => closeDrawer(triggerEl));

  // 标题（带 id 供 aria-labelledby 引用）
  const title = document.createElement("h2");
  const titleId = "drawer-title-" + Date.now();
  title.id = titleId;
  title.className = "drawer-title";
  title.textContent = site.name;
  drawer.setAttribute("aria-labelledby", titleId);

  // 详情内容
  const body = document.createElement("div");
  body.className = "drawer-body";

  // 基本信息
  const infoItems = [
    ["类型", (KIND_BADGE[site.kind] || KIND_BADGE.api_site).label],
    ["额度原文", site.quotaRaw || "—"],
    ["模型", site.models || "—"],
    ["倍率", site.rate || "—"],
    ["注册要求", site.register || "—"],
    ["创建时间", site.createdAt ? new Date(parseUtc(site.createdAt)).toLocaleDateString("zh-CN") : "—"],
    ["最后更新", site.updatedAt ? new Date(parseUtc(site.updatedAt)).toLocaleDateString("zh-CN") : "—"],
    ["最后验证", site.verifiedAt ? `${relativeTime(site.verifiedAt)} (${site.verifiedBy || ""})` : "未验证"]
  ];

  const dl = document.createElement("dl");
  dl.className = "detail-list";
  infoItems.forEach(([label, value]) => {
    if (!value || value === "—") return;
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    dl.append(dt, dd);
  });
  body.appendChild(dl);

  // 备注
  if (site.notes && site.notes.length) {
    const notesSection = document.createElement("div");
    notesSection.className = "drawer-notes";
    notesSection.innerHTML = '<h3>备注</h3>';
    site.notes.forEach((note) => {
      const p = document.createElement("p");
      p.textContent = note;
      notesSection.appendChild(p);
    });
    body.appendChild(notesSection);
  }

  // 投票区
  const voteSection = document.createElement("div");
  voteSection.className = "drawer-vote";
  voteSection.appendChild(makeVoteBar(site.name));
  body.appendChild(voteSection);

  // 反馈按钮
  const feedbackRow = document.createElement("div");
  feedbackRow.className = "drawer-feedback";
  const fbBtn = document.createElement("button");
  fbBtn.type = "button";
  fbBtn.className = "feedback-trigger";
  fbBtn.textContent = "💬 反馈问题";
  fbBtn.addEventListener("click", () => {
    closeDrawer();
    openFeedbackModal(site.name);
  });
  feedbackRow.appendChild(fbBtn);
  body.appendChild(feedbackRow);

  drawer.append(closeBtn, title, body);
  overlay.appendChild(drawer);
  document.body.appendChild(overlay);

  // 动画 + 聚焦关闭按钮（a11y）
  requestAnimationFrame(() => {
    overlay.classList.add("open");
    closeBtn.focus();
  });

  // Focus trap + ESC 关闭（a11y）
  const onKey = (e) => {
    if (e.key === "Escape") {
      closeDrawer(triggerEl);
      document.removeEventListener("keydown", onKey);
      overlay.removeEventListener("focusin", onFocusIn);
      return;
    }
    if (e.key === "Tab") {
      const focusable = drawer.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  const onFocusIn = (e) => {
    if (!drawer.contains(e.target)) {
      e.stopPropagation();
      closeBtn.focus();
    }
  };
  document.addEventListener("keydown", onKey);
  overlay.addEventListener("focusin", onFocusIn);
}

function closeDrawer(triggerEl) {
  const overlay = document.querySelector(".drawer-overlay");
  if (overlay) {
    overlay.classList.remove("open");
    setTimeout(() => overlay.remove(), 300);
  }
  state.drawerSite = null;
  // 恢复焦点到触发元素（a11y）
  if (triggerEl && typeof triggerEl.focus === "function") {
    triggerEl.focus();
  }
}
