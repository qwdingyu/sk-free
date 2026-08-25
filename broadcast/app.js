(function () {
  // ═══════════════════════════════════════════════════════════════════════════════
  // 常量配置
  // ═══════════════════════════════════════════════════════════════════════════════
  // 所有 API 使用同源相对路径（Worker 即数据源，无降级逻辑）
  const API_BASE = "";
  const VOTE_CACHE_TTL = 5 * 60 * 1000;  // 投票数据缓存 5 分钟
  const CACHE_BUSTER = () => `v=${Date.now()}`;
  const THEME_KEY = "broadcast-theme";
  const VOTE_STORAGE_KEY = "sk-free-votes";
  const THEME_CHOICES = ["light", "dark", "system"];
  // 去掉了 "DC系" 和 "抽奖"：线上 18 条数据里这两个标签命中 0 条，
  // 是两个永远筛不出东西的按钮。阶段 B 会用 needsProxy 取代 DC 系列标签。
  const PRIORITY_TAGS = ["全部", "签到", "生图", "半DC", "非DC"];
  const SORT_OPTIONS = [
    { value: "default", label: "默认排序" },
    { value: "fresh",   label: "最近验证" },
    { value: "quota",   label: "额度档位" },
    { value: "score",   label: "按评分排序" }
  ];

  // ─── 结构化额度字段的展示映射（0003 引入）───────────────────────────────────
  // 单位一律由后端 quotaUnit 决定。缺失就不显示单位，绝不默认成 "刀"。
  const UNIT_LABELS = {
    usd: "刀",
    cny: "元",
    credit: "积分",
    coin: "硬币",
    token: "代币",
    call: "次"
  };
  const PERIOD_LABELS = {
    daily: "每日",
    weekly: "每周",
    once: "一次性",
    none: ""
  };
  const TIER_LABELS = { high: "高额度", mid: "中额度", low: "小额度", none: "" };
  // 跨单位无汇率，排序只依据人工判定的档位
  const TIER_ORDER = { high: 3, mid: 2, low: 1, none: 0 };
  const KIND_LABELS = {
    api_site: "",
    bot: "TG 机器人",
    account_pool: "号池",
    tool: "工具"
  };
  const TAG_CLASS = {
    "签到": "checkin",
    "生图": "image"
  };
  const DATE_PATTERN = /(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*(?:日)?/g;

  // ═══════════════════════════════════════════════════════════════════════════════
  // 全局状态
  // ═══════════════════════════════════════════════════════════════════════════════
  const state = {
    sites: [],
    metadata: {},
    activeTag: "全部",
    query: "",
    sortBy: "default",
    votes: {}
  };

  // ═══════════════════════════════════════════════════════════════════════════════
  // DOM 引用
  // ═══════════════════════════════════════════════════════════════════════════════
  const els = {
    searchInput: document.getElementById("searchInput"),
    summaryStrip: document.getElementById("summaryStrip"),
    filterRow: document.getElementById("filterRow"),
    noticeBand: document.getElementById("noticeBand"),
    noticeContent: document.getElementById("noticeContent"),
    cardsArea: document.getElementById("cardsArea"),
    template: document.getElementById("siteCardTemplate"),
    themeButtons: document.querySelectorAll("[data-theme-choice]")
  };

  // ═══════════════════════════════════════════════════════════════════════════════
  // 工具函数
  // ═══════════════════════════════════════════════════════════════════════════════

  function unique(values) {
    return Array.from(new Set(values.filter(Boolean)));
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // 投票系统
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * 从 Cloudflare Worker API 获取所有站点的投票数据
   * 支持 5 分钟本地缓存，减少 API 调用
   * API 不可用时静默降级，不影响站点列表渲染
   */
  async function loadVotes() {
    // 优先使用内存缓存（避免页面内重复请求）
    if (state._voteCache && Date.now() - state._voteCache.ts < VOTE_CACHE_TTL) {
      state.votes = state._voteCache.data;
      return;
    }

    try {
      const res = await fetch("/api/votes?" + CACHE_BUSTER(), {
        cache: "no-store"
      });
      if (!res.ok) throw new Error("votes " + res.status);
      const data = await res.json();
      if (data.ok) {
        state.votes = data.votes || {};
        state._voteCache = { data: state.votes, ts: Date.now() };
      }
    } catch {
      // API 不可用时静默降级，投票区域将被隐藏
    }
  }

  /**
   * 从 localStorage 读取当前用户的投票记录
   * 结构：{ "站点名": "up" | "down" }
   */
  function loadPersonalVotes() {
    try {
      return JSON.parse(localStorage.getItem(VOTE_STORAGE_KEY) || "{}");
    } catch {
      return {};
    }
  }

  /**
   * 将用户的投票记录持久化到 localStorage
   */
  function savePersonalVotes(votes) {
    try {
      localStorage.setItem(VOTE_STORAGE_KEY, JSON.stringify(votes));
    } catch {
      // localStorage 不可用时忽略（隐私模式等）
    }
  }

  /**
   * 计算站点的净得分（👍数 - 👎数）
   * @param {string} siteName - 站点名称
   * @returns {number} 净得分
   */
  function netVotes(siteName) {
    const v = state.votes[siteName];
    if (!v) return 0;
    return (v.up || 0) - (v.down || 0);
  }

  /**
   * 处理用户点击投票按钮
   * 流程：前端校验 → API 请求 → 乐观更新 → 持久化
   * @param {string} siteName - 站点名称
   * @param {string} vote - "up" 或 "down"
   * @param {HTMLElement} voteBar - 投票按钮组的容器元素
   */
  async function handleVote(siteName, vote, voteBar) {
    // 从 localStorage 读取当前用户的所有投票记录
    const personalVotes = loadPersonalVotes();

    // 检查是否已对该站点投过票
    if (personalVotes[siteName]) {
      voteBar.classList.add("vote-flash");
      setTimeout(() => voteBar.classList.remove("vote-flash"), 600);
      return;
    }

    // 禁用按钮防止重复点击
    const buttons = voteBar.querySelectorAll(".vote-btn");
    buttons.forEach((b) => (b.disabled = true));

    try {
      const res = await fetch("/api/vote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteName: siteName, type: vote })
      });

      const data = await res.json();

      if (data.ok) {
        // 乐观更新：服务端返回 { ok, siteName, up, down }，组装成 votes 结构
        state.votes[siteName] = { up: data.up || 0, down: data.down || 0 };
        // 清除缓存，确保下次获取最新数据
        state._voteCache = null;
        // 记录用户投票（防止重复投票）
        personalVotes[siteName] = vote;
        savePersonalVotes(personalVotes);
        // 更新 UI
        refreshVoteBar(voteBar, siteName);
      } else if (res.status === 429) {
        // 被速率限制：提示用户
        voteBar.classList.add("vote-flash");
        setTimeout(() => voteBar.classList.remove("vote-flash"), 600);
        alert(data.error || "投票过于频繁，请稍后再试");
      } else {
        alert(data.error || "投票失败");
      }
    } catch {
      alert("网络错误，请稍后重试");
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  }

  /**
   * 刷新投票按钮组的视觉状态
   * 更新计数显示、激活状态、禁用状态
   * @param {HTMLElement} voteBar - 投票按钮组容器
   * @param {string} siteName - 站点名称
   */
  function refreshVoteBar(voteBar, siteName) {
    const personalVotes = loadPersonalVotes();
    const userVote = personalVotes[siteName] || null;
    const score = netVotes(siteName);

    // 更新得分数字及颜色
    const scoreEl = voteBar.querySelector(".vote-score");
    if (scoreEl) {
      scoreEl.textContent = score > 0 ? `+${score}` : String(score);
      scoreEl.className = "vote-score" + (score > 0 ? " positive" : score < 0 ? " negative" : "");
    }

    // 更新按钮激活状态
    const upBtn = voteBar.querySelector("[data-vote='up']");
    const downBtn = voteBar.querySelector("[data-vote='down']");

    if (upBtn) {
      upBtn.classList.toggle("is-active", userVote === "up");
      upBtn.disabled = !!userVote;
    }
    if (downBtn) {
      downBtn.classList.toggle("is-active", userVote === "down");
      downBtn.disabled = !!userVote;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // 主题系统
  // ═══════════════════════════════════════════════════════════════════════════════

  const colorSchemeQuery =
    window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");

  function getStoredTheme() {
    try {
      const value = localStorage.getItem(THEME_KEY) || "system";
      return THEME_CHOICES.includes(value) ? value : "system";
    } catch {
      return document.documentElement.dataset.themeChoice || "system";
    }
  }

  function resolveTheme(choice) {
    if (choice === "system") {
      return colorSchemeQuery && colorSchemeQuery.matches ? "dark" : "light";
    }
    return choice;
  }

  function applyTheme(choice, persist = false) {
    const safeChoice = THEME_CHOICES.includes(choice) ? choice : "system";
    document.documentElement.dataset.theme = resolveTheme(safeChoice);
    document.documentElement.dataset.themeChoice = safeChoice;

    els.themeButtons.forEach((button) => {
      const active = button.dataset.themeChoice === safeChoice;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });

    if (persist) {
      try {
        localStorage.setItem(THEME_KEY, safeChoice);
      } catch {
        // Storage can be unavailable in strict browser modes.
      }
    }
  }

  function initTheme() {
    els.themeButtons.forEach((button) => {
      button.addEventListener("click", () => {
        applyTheme(button.dataset.themeChoice, true);
      });
    });

    if (colorSchemeQuery) {
      const handleChange = () => {
        if (getStoredTheme() === "system") applyTheme("system");
      };

      if (colorSchemeQuery.addEventListener) {
        colorSchemeQuery.addEventListener("change", handleChange);
      } else if (colorSchemeQuery.addListener) {
        colorSchemeQuery.addListener(handleChange);
      }
    }

    applyTheme(getStoredTheme());
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // 日期工具
  // ═══════════════════════════════════════════════════════════════════════════════

  function todayInShanghai() {
    const parts = new Intl.DateTimeFormat("en", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }

  function extractDescriptionDates(site) {
    const text = [
      site.checkin,
      site.summary,
      site.register,
      site.models,
      site.rate,
      ...(site.notes || [])
    ]
      .filter(Boolean)
      .join(" ");

    return Array.from(text.matchAll(DATE_PATTERN), (match) => {
      const [, year, month, day] = match;
      return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    });
  }

  function isCurrentDatedSite(site) {
    const dates = extractDescriptionDates(site);
    return !dates.length || dates.every((date) => date === todayInShanghai());
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // 过滤与排序
  // ═══════════════════════════════════════════════════════════════════════════════

  function matches(site) {
    const haystack = [
      site.name,
      site.url,
      site.checkin,
      site.summary,
      ...(site.tags || []),
      ...(site.notes || [])
    ]
      .join(" ")
      .toLowerCase();

    const queryMatch = !state.query || haystack.includes(state.query.toLowerCase());
    const tagMatch = state.activeTag === "全部" || (site.tags || []).includes(state.activeTag);
    return queryMatch && tagMatch;
  }

  /**
   * 获取过滤后的站点列表，并根据当前排序方式排序
   */
  function filteredSites() {
    const list = state.sites.filter(matches);

    if (state.sortBy === "score") {
      // 按评分排序：高分在前
      list.sort((a, b) => netVotes(b.name) - netVotes(a.name));
    } else if (state.sortBy === "quota") {
      // 跨单位无汇率，只能按人工判定的档位排；同档位内按最近验证时间
      list.sort((a, b) => (tierRank(b) - tierRank(a)) || (verifiedTs(b) - verifiedTs(a)));
    } else if (state.sortBy === "fresh") {
      // 最近验证在前；同鲜度按额度档位
      list.sort((a, b) => (verifiedTs(b) - verifiedTs(a)) || (tierRank(b) - tierRank(a)));
    }

    // 已失效的一律沉到末尾（展示但不占据决策位）
    list.sort((a, b) => (a.dead ? 1 : 0) - (b.dead ? 1 : 0));

    return list;
  }

  /** 额度档位的排序权重；无档位算 0 */
  function tierRank(site) {
    return TIER_ORDER[site.quotaTier] || 0;
  }

  /** 最后验证时间戳；未验证算 0（排到最后） */
  function verifiedTs(site) {
    if (!site.verifiedAt) return 0;
    const ts = Date.parse(site.verifiedAt.replace(" ", "T") + "Z");
    return Number.isNaN(ts) ? 0 : ts;
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // 渲染
  // ═══════════════════════════════════════════════════════════════════════════════

  function renderSummary() {
    // 统计条一律用全量数据，不用筛选结果。
    // 旧实现用 filteredSites().length 当"收录"，一筛选就变成"收录 3 个站"，
    // 而这一栏的语义是"这个站收录了多少"，不是"你筛出了多少"。
    const all = state.sites;
    const visible = filteredSites();
    const daily = all.filter((site) => site.quotaPeriod === "daily").length;
    const deadCount = state.metadata.dead ?? all.filter((site) => site.dead).length;

    const stats = [
      ["收录", state.metadata.total ?? all.length],
      ["每日可签到", daily],
      ["可生图", all.filter((site) => (site.tags || []).includes("生图")).length]
    ];
    if (deadCount > 0) stats.push(["已失效", deadCount]);
    // 只有真的在筛选时才显示"匹配"，避免和"收录"混淆
    if (visible.length !== all.length) stats.push(["当前匹配", visible.length]);

    els.summaryStrip.replaceChildren(
      ...stats.map(([label, value]) => {
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

  function renderFilters() {
    const allTags = unique(state.sites.flatMap((site) => site.tags || []));
    const ordered = [
      ...PRIORITY_TAGS.filter((tag) => tag === "全部" || allTags.includes(tag)),
      ...allTags.filter((tag) => !PRIORITY_TAGS.includes(tag)).sort((a, b) => a.localeCompare(b, "zh-CN"))
    ];

    els.filterRow.replaceChildren(
      ...ordered.map((tag) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `filter-button${tag === state.activeTag ? " is-active" : ""}`;
        button.textContent = tag;
        button.addEventListener("click", () => {
          state.activeTag = tag;
          render();
        });
        return button;
      })
    );

    // 追加排序选择器到筛选行末尾
    const sortGroup = document.createElement("div");
    sortGroup.className = "sort-group";

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
      renderCards();
    });

    sortGroup.append(sortLabel, sortSelect);
    els.filterRow.appendChild(sortGroup);
  }

  function appendFact(list, label, value) {
    if (!value) return;
    const row = document.createElement("div");
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = label;
    dd.textContent = value;
    row.append(dt, dd);
    list.append(row);
  }

  function makeTags(tags) {
    return (tags || []).map((tag) => {
      const item = document.createElement("li");
      const span = document.createElement("span");
      span.className = `tag ${TAG_CLASS[tag] || ""}`.trim();
      span.textContent = tag;
      item.append(span);
      return item;
    });
  }

  /**
   * 构建投票按钮组 DOM 元素
   * 包含 👍 按钮、得分显示、👎 按钮
   * @param {string} siteName - 站点名称（用于 API 请求和状态查找）
   * @returns {HTMLElement} 投票按钮组容器
   */
  function makeVoteBar(siteName) {
    const bar = document.createElement("div");
    bar.className = "vote-bar";

    const personalVotes = loadPersonalVotes();
    const userVote = personalVotes[siteName] || null;
    const score = netVotes(siteName);

    // 👍 按钮
    const upBtn = document.createElement("button");
    upBtn.type = "button";
    upBtn.className = "vote-btn vote-up" + (userVote === "up" ? " is-active" : "");
    upBtn.setAttribute("aria-label", "支持");
    upBtn.textContent = "👍";
    upBtn.disabled = !!userVote;
    upBtn.addEventListener("click", () => handleVote(siteName, "up", bar));

    // 得分显示
    const scoreEl = document.createElement("span");
    scoreEl.className = "vote-score" + (score > 0 ? " positive" : score < 0 ? " negative" : "");
    scoreEl.textContent = score > 0 ? `+${score}` : String(score);

    // 👎 按钮
    const downBtn = document.createElement("button");
    downBtn.type = "button";
    downBtn.className = "vote-btn vote-down" + (userVote === "down" ? " is-active" : "");
    downBtn.setAttribute("aria-label", "不推荐");
    downBtn.textContent = "👎";
    downBtn.disabled = !!userVote;
    downBtn.addEventListener("click", () => handleVote(siteName, "down", bar));

    bar.append(upBtn, scoreEl, downBtn);
    return bar;
  }

  /**
   * 根据结构化额度字段生成醒目徽章
   *
   * 为什么不再从 checkin 文本里正则抓数字：
   *   旧实现取文本里最大的数再一律拼 "刀"，于是
   *   "每日签到100积分（约60次API调用）" 显示成 "100 刀"，
   *   "签到1-5积分" 显示成 "5 刀"。这是在向用户输出假信息。
   *   现在单位由后端 quotaUnit 给出，缺失就不显示单位——宁可少说，不能说错。
   *
   * 跨单位没有汇率（刀/元/积分/硬币/代币互不可换算），
   * 所以分级只依据人工判定的 quotaTier，不依据数字大小。
   *
   * @param {Object} site - 站点数据对象
   * @returns {HTMLElement|null} 徽章元素，无可信额度数据时返回 null
   */
  function makeQuotaBadge(site) {
    const tier = site.quotaTier && site.quotaTier !== "none" ? site.quotaTier : null;
    const unit = site.quotaUnit ? UNIT_LABELS[site.quotaUnit] || site.quotaUnit : null;
    const min = site.quotaMin;
    const max = site.quotaMax;
    const hasAmount = typeof min === "number" || typeof max === "number";

    // 既没有额度数值也没有档位 → 没有可展示的可信信息
    if (!hasAmount && !tier) return null;

    let text;
    if (hasAmount) {
      const lo = typeof min === "number" ? min : max;
      const hi = typeof max === "number" ? max : min;
      const amount = lo === hi ? String(lo) : lo + "-" + hi;
      text = unit ? amount + " " + unit : amount;
    } else {
      text = TIER_LABELS[tier];
    }

    const badge = document.createElement("span");
    // 沿用 checkin-* 类名，样式表和卡片分级逻辑无需改动
    badge.className = "checkin-badge checkin-" + (tier || "low");
    badge.textContent = text;

    // 悬浮显示完整信息：周期、估算次数、原始文案
    const title = [];
    if (site.quotaPeriod && PERIOD_LABELS[site.quotaPeriod]) {
      title.push(PERIOD_LABELS[site.quotaPeriod]);
    }
    if (typeof site.quotaCallsEst === "number") {
      title.push("约 " + site.quotaCallsEst + " 次调用");
    }
    if (site.quotaRaw) title.push("原文：" + site.quotaRaw);
    else if (site.checkin) title.push("原文：" + site.checkin);
    badge.title = title.join(" · ");

    return badge;
  }

  /**
   * 生成鲜度指示器
   * 鲜度是这个站的核心价值：数据是不是今天还有效。
   * 没验证过就明说"未验证"，不假装新鲜。
   * @param {Object} site - 站点数据对象
   * @returns {HTMLElement} 鲜度元素
   */
  function makeFreshness(site) {
    const el = document.createElement("span");
    el.className = "freshness";

    if (!site.verifiedAt) {
      el.classList.add("freshness-unknown");
      el.textContent = "⚫ 未验证";
      el.title = "尚无验证记录";
      return el;
    }

    // 后端存的是 UTC 的 "YYYY-MM-DD HH:MM:SS"，转成 ISO 才能被正确解析
    const ts = Date.parse(site.verifiedAt.replace(" ", "T") + "Z");
    if (Number.isNaN(ts)) {
      el.classList.add("freshness-unknown");
      el.textContent = "⚫ 未验证";
      return el;
    }

    const hours = (Date.now() - ts) / 36e5;
    let dot, label;
    if (hours <= 24) {
      el.classList.add("freshness-fresh");
      dot = "🟢";
      label = hours < 1 ? "刚刚验证" : Math.floor(hours) + " 小时前验证";
    } else if (hours <= 24 * 7) {
      el.classList.add("freshness-ok");
      dot = "🟡";
      label = Math.floor(hours / 24) + " 天前验证";
    } else {
      el.classList.add("freshness-stale");
      dot = "⚪";
      label = Math.floor(hours / 24) + " 天前验证";
    }
    el.textContent = dot + " " + label;
    el.title = "最后验证：" + site.verifiedAt + " UTC" + (site.verifiedBy ? "（" + site.verifiedBy + "）" : "");
    return el;
  }

  /**
   * 构建单个站点卡片 DOM
   * @param {Object} site - 站点数据对象
   * @returns {HTMLElement} 卡片元素
   */
  function makeCard(site) {
    const node = els.template.content.firstElementChild.cloneNode(true);

    node.querySelector("h2").textContent = site.name;
    node.querySelector(".summary").textContent = site.summary || "";

    // 实体类型徽章：18 条数据里混了 API 站 / TG 机器人 / 号池 / 域名工具四种，
    // 不标出来的话用户会拿"机器人"当 API 站去接
    const kindLabel = KIND_LABELS[site.kind];
    if (kindLabel) {
      const kindEl = document.createElement("span");
      kindEl.className = "kind-badge";
      kindEl.textContent = kindLabel;
      node.querySelector(".card-head").appendChild(kindEl);
    }

    // 鲜度：这个站的核心价值就是"今天还能不能用"
    node.querySelector(".card-head").appendChild(makeFreshness(site));

    // 已失效：显示而不是隐藏。后端现在返回 dead 标记而不是把死链过滤掉，
    // 前端必须把它标出来——否则死链会和正常站点长得一模一样。
    if (site.dead) {
      node.classList.add("card-dead");
      const deadEl = document.createElement("span");
      deadEl.className = "dead-badge";
      deadEl.textContent = "已失效";
      deadEl.title = "最近一次检测无法访问，可能已关站或临时故障";
      node.querySelector(".card-head").appendChild(deadEl);
    }

    const facts = node.querySelector(".quick-facts");
    appendFact(facts, "签到", site.quotaRaw || site.checkin);
    appendFact(facts, "模型", site.models);
    appendFact(facts, "注册", site.register);
    appendFact(facts, "倍率", site.rate);

    node.querySelector(".tag-list-top").replaceChildren(...makeTags(site.tags));

    // 插入投票按钮组到底部栏（访问按钮右侧）
    const cardFoot = node.querySelector(".card-foot");
    cardFoot.appendChild(makeVoteBar(site.name));

    // 插入反馈按钮
    const feedbackBtn = document.createElement("button");
    feedbackBtn.type = "button";
    feedbackBtn.className = "feedback-trigger";
    feedbackBtn.textContent = "💬 反馈";
    feedbackBtn.addEventListener("click", () => openFeedbackModal(site.name));
    cardFoot.appendChild(feedbackBtn);

    // 额度徽章只生成一次（旧代码为了取 level 又调了第二遍）
    const badge = makeQuotaBadge(site);
    const checkinFact = facts.querySelector("div:first-child");
    if (badge && checkinFact) {
      checkinFact.appendChild(badge);
    }

    // 卡片视觉分级：直接用人工判定的额度档位，不再靠正则抓出的数字大小
    if (site.quotaTier && site.quotaTier !== "none") {
      node.classList.add("card-graded");
      if (site.quotaTier === "high") {
        node.classList.add("card-tier-high");
      } else if (site.quotaTier === "mid") {
        node.classList.add("card-tier-mid");
      }
    }

    const notes = node.querySelector(".notes");
    (site.notes || []).forEach((text) => {
      const p = document.createElement("p");
      p.textContent = text;
      notes.append(p);
    });

    const link = node.querySelector(".visit-link");
    link.href = site.url;
    link.setAttribute("aria-label", `访问 ${site.name}`);
    return node;
  }

  function renderCards() {
    const visible = filteredSites();
    if (!visible.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "没有匹配的站点。";
      els.cardsArea.replaceChildren(empty);
      return;
    }

    const grid = document.createElement("div");
    grid.className = "card-grid";
    grid.replaceChildren(...visible.map(makeCard));
    els.cardsArea.replaceChildren(grid);

  }

  function renderNotice(markdown) {
    const text = markdown.trim();
    if (!text) return;

    const paragraphs = text
      .split(/\n{2,}/)
      .map((block) => block.trim())
      .filter(Boolean)
      .slice(0, 3);

    els.noticeContent.replaceChildren(
      ...paragraphs.map((block) => {
        const p = document.createElement("p");
        p.textContent = block.replace(/\n/g, " ");
        return p;
      })
    );
    els.noticeBand.hidden = false;
  }

  /**
   * 主渲染函数：依次渲染摘要、筛选器（含排序）、卡片
   */
  function render() {
    renderSummary();
    renderFilters();
    renderCards();
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // 数据加载
  // ═══════════════════════════════════════════════════════════════════════════════

  async function loadJson() {
    const res = await fetch("/api/sites?" + CACHE_BUSTER(), { cache: "no-store" });
    if (!res.ok) throw new Error("sites " + res.status);
    const data = await res.json();
    if (!data.ok || !data.sites) throw new Error("sites API 返回异常");
    return data;
  }

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
   * 应用初始化
   * 加载站点数据 → 并行加载投票数据 → 合并 → 渲染
   */
  async function init() {
    try {
      const data = await loadJson();
      state.metadata = data.metadata || {};
      state.sites = (data.sites || []).filter((s) => s.enabled !== false);

      // 并行加载投票数据（不阻塞站点列表渲染）
      await loadVotes();

      render();
      loadNotice();
    } catch (error) {
      const box = document.createElement("div");
      box.className = "error-state";
      box.textContent = `数据加载失败：${error.message}`;
      els.cardsArea.replaceChildren(box);
      els.summaryStrip.replaceChildren();
      els.filterRow.replaceChildren();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // 提交站点
  // ═══════════════════════════════════════════════════════════════════════════════

  function initSubmitForm() {
    const btn = document.getElementById("submitSiteBtn");
    const modal = document.getElementById("submitModal");
    const form = document.getElementById("submitForm");
    const confirmBtn = document.getElementById("submitConfirmBtn");

    if (!btn || !modal || !form) return;

    btn.addEventListener("click", () => {
      form.reset();
      modal.showModal();
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      confirmBtn.disabled = true;
      confirmBtn.textContent = "提交中...";

      const body = {
        name: document.getElementById("submitName").value.trim(),
        url: document.getElementById("submitUrl").value.trim(),
        tags: document.getElementById("submitTags").value.split(",").map((t) => t.trim()).filter(Boolean),
        summary: document.getElementById("submitSummary").value.trim(),
        checkin: document.getElementById("submitCheckin").value.trim() || undefined,
        models: document.getElementById("submitModels").value.trim() || undefined,
        register: document.getElementById("submitRegister").value.trim() || undefined
      };

      try {
        const res = await fetch("/api/submit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        const data = await res.json();
        if (data.ok) {
          modal.close();
          // 显示成功提示
          const toast = document.createElement("div");
          toast.className = "submit-toast";
          toast.textContent = "✅ " + (data.message || "提交成功，等待管理员审核");
          document.body.appendChild(toast);
          setTimeout(() => toast.remove(), 4000);
        } else {
          alert(data.error || "提交失败");
        }
      } catch {
        alert("网络错误，请稍后重试");
      } finally {
        confirmBtn.disabled = false;
        confirmBtn.textContent = "提交审核";
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // 反馈系统
  // ═══════════════════════════════════════════════════════════════════════════════

  const FEEDBACK_STORAGE_KEY = "sk-free-feedbacks";

  /**
   * 从 localStorage 读取用户已提交的反馈记录
   * @returns {Object} { "站点名": true }
   */
  function loadPersonalFeedbacks() {
    try {
      return JSON.parse(localStorage.getItem(FEEDBACK_STORAGE_KEY) || "{}");
    } catch {
      return {};
    }
  }

  /**
   * 将用户的反馈记录持久化到 localStorage
   */
  function savePersonalFeedbacks(record) {
    try {
      localStorage.setItem(FEEDBACK_STORAGE_KEY, JSON.stringify(record));
    } catch {}
  }

  /**
   * 打开反馈模态框
   * @param {string} siteName - 站点名称
   */
  function openFeedbackModal(siteName) {
    const modal = document.getElementById("feedbackModal");
    const nameEl = document.getElementById("feedbackSiteName");
    const contentEl = document.getElementById("feedbackContent");
    const typeGroup = document.getElementById("feedbackTypeGroup");
    const confirmBtn = document.getElementById("feedbackConfirmBtn");
    const charCount = document.getElementById("feedbackCharCount");

    // 检查是否已反馈过
    const personalFeedbacks = loadPersonalFeedbacks();
    if (personalFeedbacks[siteName]) {
      showFeedbackToast("您已反馈过该站点，感谢您的关注！");
      return;
    }

    // 重置表单
    nameEl.textContent = "站点：" + siteName;
    contentEl.value = "";
    charCount.textContent = "0";
    confirmBtn.disabled = false;
    confirmBtn.textContent = "提交反馈";
    modal.dataset.siteName = siteName;
    modal.dataset.feedbackType = "";

    // 重置类型按钮状态
    typeGroup.querySelectorAll(".feedback-type-btn").forEach((btn) => {
      btn.classList.remove("is-active");
    });

    modal.showModal();
    contentEl.focus();
  }

  /**
   * 初始化反馈模态框事件
   */
  function initFeedbackForm() {
    const modal = document.getElementById("feedbackModal");
    const form = document.getElementById("feedbackForm");
    const typeGroup = document.getElementById("feedbackTypeGroup");
    const contentEl = document.getElementById("feedbackContent");
    const charCount = document.getElementById("feedbackCharCount");
    const confirmBtn = document.getElementById("feedbackConfirmBtn");

    if (!modal || !form) return;

    // 类型选择
    typeGroup.addEventListener("click", (e) => {
      const btn = e.target.closest(".feedback-type-btn");
      if (!btn) return;
      typeGroup.querySelectorAll(".feedback-type-btn").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      modal.dataset.feedbackType = btn.dataset.fbType;
    });

    // 字符计数
    contentEl.addEventListener("input", () => {
      charCount.textContent = String(contentEl.value.length);
    });

    // 提交
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const siteName = modal.dataset.siteName;
      const type = modal.dataset.feedbackType;
      const content = contentEl.value.trim();

      if (!type) {
        alert("请选择反馈类型");
        return;
      }
      if (content.length < 2) {
        alert("反馈内容至少需要 2 个字符");
        return;
      }

      confirmBtn.disabled = true;
      confirmBtn.textContent = "提交中...";

      try {
        const res = await fetch("/api/feedback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ siteName, type, content }),
        });
        const data = await res.json();
        if (data.ok) {
          modal.close();
          // 记录已反馈
          const personalFeedbacks = loadPersonalFeedbacks();
          personalFeedbacks[siteName] = true;
          savePersonalFeedbacks(personalFeedbacks);
          showFeedbackToast("✅ 感谢您的反馈！");
        } else {
          alert(data.error || "提交失败");
        }
      } catch {
        alert("网络错误，请稍后重试");
      } finally {
        confirmBtn.disabled = false;
        confirmBtn.textContent = "提交反馈";
      }
    });
  }

  /**
   * 显示反馈成功提示（带动画）
   * @param {string} msg - 提示文字
   */
  function showFeedbackToast(msg) {
    const existing = document.querySelector(".feedback-toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.className = "feedback-toast";
    toast.textContent = msg;
    document.body.appendChild(toast);

    // 触发动画
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        toast.classList.add("show");
      });
    });

    setTimeout(() => {
      toast.classList.remove("show");
      setTimeout(() => toast.remove(), 400);
    }, 2500);
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // 事件绑定 & 启动
  // ═══════════════════════════════════════════════════════════════════════════════

  els.searchInput.addEventListener("input", (event) => {
    state.query = event.target.value.trim();
    render();
  });

  initTheme();
  initSubmitForm();
  initFeedbackForm();
  init();
})();
