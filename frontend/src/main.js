// 广播页面入口 — 导入所有广播模块并启动应用
// 要改前端行为，请改 frontend/src/broadcast/ 下的模块，然后跑 npm run build。
// 本文件由 scripts/concat-broadcast.mjs 自动生成，请勿手工编辑。
// Modules: 00-config.js, 10-state.js, 20-utils.js, 30-api.js, 40-vote.js, 50-theme.js, 60-filter.js, 70-view-table.js, 80-view-card.js, 90-forms.js, 99-boot.js

// ── 00-config.js ───────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
// 常量配置
// ═══════════════════════════════════════════════════════════════════════════════
const API_BASE = "";
const CACHE_BUSTER = () => `v=${Date.now()}`;
const THEME_KEY = "broadcast-theme";
const VOTE_STORAGE_KEY = "sk-free-votes";
const THEME_CHOICES = ["light", "dark", "system"];

// ── 标签与筛选 ────────────────────────────────────────────────────────────────
// 生图/限免 命中率 ≥ 33%，判别力足够，保留为标签
// 签到/DC系/半DC/非DC 已迁移至结构化字段（quota_period/needs_proxy），不再用标签筛选
const TAG_CLASS = {
  "生图": "image",
  "限免": "free"
};

// ── 排序选项 ──────────────────────────────────────────────────────────────────
const SORT_OPTIONS = [
  { value: "fresh",   label: "鲜度优先" },
  { value: "quota",   label: "额度优先" },
  { value: "community", label: "社区评价" },
  { value: "name",    label: "名称排序" }
];

// ── 额度单位显示映射 ─────────────────────────────────────────────────────────
const QUOTA_UNIT_LABEL = {
  usd: "刀", cny: "元", credit: "积分", coin: "硬币", token: "代币", call: "次"
};

// ── 额度档位排序权重（高 > 中 > 低 > none）────────────────────────────────────
const TIER_ORDER = { high: 0, mid: 1, low: 2, none: 3 };

// ── 鲜度阈值（毫秒）──────────────────────────────────────────────────────────
const FRESH_24H = 24 * 60 * 60 * 1000;
const FRESH_7D  = 7 * 24 * 60 * 60 * 1000;

// ── kind 类型标签 ─────────────────────────────────────────────────────────────
const KIND_BADGE = {
  api_site: { label: "API站", icon: "" },
  bot:      { label: "机器人", icon: "🤖" },
  account_pool: { label: "号池", icon: "👤" },
  tool:     { label: "工具", icon: "🔧" }
};

// ── 搜索防抖延迟（毫秒）──────────────────────────────────────────────────────
const SEARCH_DEBOUNCE_MS = 250;

// ── 10-state.js ───────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
// 全局状态 + URL 同步
// ═══════════════════════════════════════════════════════════════════════════════
const state = {
  sites: [],          // 全量站点数据（从 API 获取）
  metadata: {},       // { total, enabled, dead, updatedAt }
  activePreset: "",   // 当前快捷视图名称（空 = 全部）
  query: "",          // 搜索关键词
  sortBy: "fresh",    // 当前排序字段
  viewMode: "table",  // "table" | "card"
  votes: {},          // { "站点名": { up, down } }
  // 精确筛选条件
  filterTier: [],     // ["high","mid"] 多选
  filterCapability: [], // ["生图","限免"] 多选
  filterKind: [],     // ["api_site","bot"] 多选
  filterThreshold: [], // ["github","telegram","email","none"] 多选
  hideStale: false,   // 隐藏 7 天未验证的站点
  showDead: false,    // 表格视图中展开死链分组
  filterPanelOpen: false, // "更多筛选"面板是否展开（必须放 state：筛选栏会整条重建）
  // 抽屉状态
  drawerSite: null    // 当前展开的站点对象，null = 关闭
};

// ═══════════════════════════════════════════════════════════════════════════════
// DOM 引用
// ═══════════════════════════════════════════════════════════════════════════════
const els = {};

function initDom() {
  els.summaryStrip = document.getElementById("summaryStrip");
  els.filterRow = document.getElementById("filterRow");
  els.noticeBand = document.getElementById("noticeBand");
  els.noticeContent = document.getElementById("noticeContent");
  els.cardsArea = document.getElementById("cardsArea");
  els.themeButtons = document.querySelectorAll("[data-theme-choice]");
}

// ═══════════════════════════════════════════════════════════════════════════════
// URL 状态同步
// ═══════════════════════════════════════════════════════════════════════════════
// 读取 URL 参数恢复状态（页面加载时调用一次）
function syncFromUrl() {
  const p = new URLSearchParams(location.search);
  if (p.has("view"))  state.viewMode = p.get("view") === "card" ? "card" : "table";
  else {
    // URL 无指定：按视口宽智能选默认视图（桌面表格 / 移动卡片）
    state.viewMode = window.innerWidth < 680 ? "card" : "table";
  }
  if (p.has("sort"))  state.sortBy = p.get("sort");
  if (p.has("q"))     state.query = p.get("q");
  if (p.has("preset")) state.activePreset = p.get("preset");
  if (p.has("tier"))  state.filterTier = p.get("tier").split(",").filter(Boolean);
  if (p.has("cap"))   state.filterCapability = p.get("cap").split(",").filter(Boolean);
  if (p.has("kind"))  state.filterKind = p.get("kind").split(",").filter(Boolean);
  if (p.has("th"))    state.filterThreshold = p.get("th").split(",").filter(Boolean);
  if (p.has("fresh")) state.hideStale = p.get("fresh") === "7";
}

// 将当前筛选状态写入 URL（不污染浏览器历史）
function syncToUrl(push) {
  const p = new URLSearchParams();
  var defaultView = window.innerWidth < 680 ? "card" : "table";
  if (state.viewMode !== defaultView) p.set("view", state.viewMode);
  if (state.sortBy !== "fresh")   p.set("sort", state.sortBy);
  if (state.query)                p.set("q", state.query);
  if (state.activePreset)         p.set("preset", state.activePreset);
  if (state.filterTier.length)    p.set("tier", state.filterTier.join(","));
  if (state.filterCapability.length) p.set("cap", state.filterCapability.join(","));
  if (state.filterKind.length)    p.set("kind", state.filterKind.join(","));
  if (state.filterThreshold.length) p.set("th", state.filterThreshold.join(","));
  if (state.hideStale)            p.set("fresh", "7");
  const qs = p.toString();
  const url = qs ? `?${qs}` : location.pathname;
  if (push) history.pushState(null, "", url);
  else history.replaceState(null, "", url);
}

// 监听浏览器前进/后退
window.addEventListener("popstate", () => {
  syncFromUrl();
  render();
});

// ── 20-utils.js ───────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 数组去重并过滤空值
 */
function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

/**
 * 防抖：延迟执行，连续调用只执行最后一次
 * @param {Function} fn - 要防抖的函数
 * @param {number} ms - 延迟毫秒数
 * @returns {Function} 防抖后的函数
 */
function debounce(fn, ms) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

/**
 * 解析 D1 的时间字符串为毫秒时间戳
 *
 * D1 里所有时间都是 SQLite 的 datetime('now') 产物，格式为
 * "YYYY-MM-DD HH:MM:SS"，**内容是 UTC 但字符串里没有时区标记**。
 * 直接 new Date("2026-08-25 15:24:54") 会被当成本地时间：
 * 在 UTC+8 下实测偏差 8 小时 —— 刚验证过的站点显示"8小时前"，
 * 本该保持 24 小时的绿色鲜度只剩 16 小时。
 * 而且这个格式不是 ISO 8601，某些浏览器直接返回 Invalid Date → NaN。
 *
 * 所以必须补上 T 和 Z 再交给 Date 解析。
 *
 * @param {string} s - D1 时间字符串，或已带时区的 ISO 字符串
 * @returns {number} 毫秒时间戳；无法解析时返回 NaN
 */
function parseUtc(s) {
  if (!s) return NaN;
  if (typeof s === "number") return s;
  const str = String(s).trim();
  // 已经带时区信息（Z 或 ±HH:MM）就直接解析
  if (/[Zz]$/.test(str) || /[+-]\d{2}:?\d{2}$/.test(str)) return Date.parse(str);
  // "YYYY-MM-DD HH:MM:SS" → "YYYY-MM-DDTHH:MM:SSZ"
  const m = str.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/);
  if (m) return Date.parse(`${m[1]}T${m[2]}Z`);
  return Date.parse(str);
}

/**
 * 相对时间格式化（如 "2小时前"、"3天前"）
 * @param {string} isoStr - D1 时间字符串或 ISO 8601 字符串
 * @returns {string} 相对时间文本
 */
function relativeTime(isoStr) {
  if (!isoStr) return "";
  const ts = parseUtc(isoStr);
  if (Number.isNaN(ts)) return "";
  const diff = Date.now() - ts;
  // 允许 60 秒时钟偏差，超过此范围仍显示"刚刚"（比显示负数时间好）
  if (diff < -60000) return "刚刚";
  if (diff < 0) return "刚刚";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins}分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}天前`;
  const months = Math.floor(days / 30);
  return `${months}个月前`;
}

/**
 * 计算鲜度等级（绿/黄/灰/未验证）
 * @param {string} verifiedAt - D1 时间字符串
 * @returns {{ color: string, label: string, cls: string }}
 */
function freshnessLevel(verifiedAt) {
  if (!verifiedAt) return { color: "gray", label: "未验证", cls: "fresh-unknown" };
  const ts = parseUtc(verifiedAt);
  // 时间字段存在但解析不出来 → 说成"未验证"，不假装有鲜度
  if (Number.isNaN(ts)) return { color: "gray", label: "未验证", cls: "fresh-unknown" };
  const diff = Date.now() - ts;
  if (diff <= FRESH_24H)  return { color: "green", label: relativeTime(verifiedAt), cls: "fresh-green" };
  if (diff <= FRESH_7D)   return { color: "yellow", label: relativeTime(verifiedAt), cls: "fresh-yellow" };
  return { color: "stale", label: relativeTime(verifiedAt), cls: "fresh-stale" };
}

/**
 * 额度显示文本
 * @param {Object} site - 站点对象
 * @returns {string} 如 "25 刀/天"、"100 积分 ≈60次"、"额度未知"
 */
function quotaText(site) {
  // 必须用"是否为 null/undefined"判断，不能用真假值判断。
  // 0 是有效额度，null 才是未知，两者不能混。修复前的实测行为：
  //   min=null, max=50   → "null-50 积分/天"  ← 把 null 直接印给用户看
  //   min=0,    max=0    → "额度未知"         ← 明确填了 0 却当成没填
  //   min=0,    max=null → "额度未知"         ← 同上
  //   （min=0, max=50 这种区间修复前是对的，没有回归风险）
  // 管理后台加上结构化字段输入框之后，"只填上限"和"填 0"都能真填进来，
  // 这两条就会被踩到。
  const hasMin = site.quotaMin !== null && site.quotaMin !== undefined;
  const hasMax = site.quotaMax !== null && site.quotaMax !== undefined;

  if (site.quotaTier === "none" || (!hasMin && !hasMax)) {
    return site.quotaRaw || "额度未知";
  }
  const unit = QUOTA_UNIT_LABEL[site.quotaUnit] || site.quotaUnit || "";
  const period = site.quotaPeriod === "daily" ? "/天" : site.quotaPeriod === "once" ? "（一次性）" : "";
  let text = "";
  if (!hasMin) {
    // 只有上限：写成"最多 N"，别把缺失的下限印成 null
    text = `最多 ${site.quotaMax} ${unit}`;
  } else if (!hasMax || site.quotaMin === site.quotaMax) {
    text = `${site.quotaMin} ${unit}`;
  } else {
    text = `${site.quotaMin}-${site.quotaMax} ${unit}`;
  }
  if (site.quotaCallsEst) text += ` ≈${site.quotaCallsEst}次`;
  return text + period;
}

/**
 * 净票数
 */
function netVotes(siteName) {
  const v = state.votes[siteName];
  if (!v) return 0;
  return (v.up || 0) - (v.down || 0);
}

/**
 * 解析门槛文本为标签
 * @param {string} register - 注册要求文本
 * @returns {string[]} 如 ["GitHub", "Telegram"]
 */
function parseThreshold(register) {
  if (!register) return [];
  const text = register.toLowerCase();
  const tags = [];
  if (text.includes("github")) tags.push("GitHub");
  if (text.includes("telegram") || text.includes("tg")) tags.push("Telegram");
  if (text.includes("邮箱") || text.includes("email")) tags.push("邮箱");
  if (tags.length === 0 && register.trim()) tags.push("其他");
  if (tags.length === 0) tags.push("无门槛");
  return tags;
}

// ── 30-api.js ───────────────────────────────────────────────────────────────
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

// ── 40-vote.js ───────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
// 投票系统
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 从 localStorage 读取当前用户的投票记录
 * @returns {Object} { "站点名": "up" | "down" }
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
 * 处理用户点击投票按钮
 * 流程：前端校验 → API 请求 → 乐观更新 → 持久化
 */
async function handleVote(siteName, vote, voteBar) {
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
      state.votes[siteName] = { up: data.up || 0, down: data.down || 0 };
      personalVotes[siteName] = vote;
      savePersonalVotes(personalVotes);
      refreshVoteBar(voteBar, siteName);
    } else if (res.status === 429) {
      voteBar.classList.add("vote-flash");
      setTimeout(() => voteBar.classList.remove("vote-flash"), 600);
      toast(data.error || "投票过于频繁，请稍后再试", "error");
    } else {
      toast(data.error || "投票失败", "error");
    }
  } catch {
    toast("网络错误，请稍后重试", "error");
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

/**
 * 刷新投票按钮组的视觉状态
 */
function refreshVoteBar(voteBar, siteName) {
  const personalVotes = loadPersonalVotes();
  const userVote = personalVotes[siteName] || null;
  const score = netVotes(siteName);

  const scoreEl = voteBar.querySelector(".vote-score");
  if (scoreEl) {
    scoreEl.textContent = score > 0 ? `+${score}` : String(score);
    scoreEl.className = "vote-score" + (score > 0 ? " positive" : score < 0 ? " negative" : "");
  }

  const upBtn = voteBar.querySelector("[data-vote='up']");
  const downBtn = voteBar.querySelector("[data-vote='down']");
  if (upBtn) {
    upBtn.classList.toggle("is-active", userVote === "up");
    upBtn.setAttribute("aria-pressed", String(userVote === "up"));
    upBtn.disabled = !!userVote;
  }
  if (downBtn) {
    downBtn.classList.toggle("is-active", userVote === "down");
    downBtn.setAttribute("aria-pressed", String(userVote === "down"));
    downBtn.disabled = !!userVote;
  }
}

/**
 * 构建投票按钮组 DOM 元素
 */
function makeVoteBar(siteName) {
  const bar = document.createElement("div");
  bar.className = "vote-bar";

  const personalVotes = loadPersonalVotes();
  const userVote = personalVotes[siteName] || null;
  const score = netVotes(siteName);

  const upBtn = document.createElement("button");
  upBtn.type = "button";
  upBtn.className = "vote-btn vote-up" + (userVote === "up" ? " is-active" : "");
  upBtn.setAttribute("aria-label", "支持");
  upBtn.setAttribute("aria-pressed", String(userVote === "up"));
  upBtn.textContent = "👍";
  upBtn.disabled = !!userVote;
  upBtn.addEventListener("click", () => handleVote(siteName, "up", bar));

  const scoreEl = document.createElement("span");
  scoreEl.className = "vote-score" + (score > 0 ? " positive" : score < 0 ? " negative" : "");
  scoreEl.textContent = score > 0 ? `+${score}` : String(score);

  const downBtn = document.createElement("button");
  downBtn.type = "button";
  downBtn.className = "vote-btn vote-down" + (userVote === "down" ? " is-active" : "");
  downBtn.setAttribute("aria-label", "不推荐");
  downBtn.setAttribute("aria-pressed", String(userVote === "down"));
  downBtn.textContent = "👎";
  downBtn.disabled = !!userVote;
  downBtn.addEventListener("click", () => handleVote(siteName, "down", bar));

  bar.append(upBtn, scoreEl, downBtn);
  return bar;
}

// ── 50-theme.js ───────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
// 主题系统（亮色/暗色/跟随系统）
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

// ── 60-filter.js ───────────────────────────────────────────────────────────────
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
function aliveMatchCount(list) {
  const base = Array.isArray(list) ? list : state.sites;
  return base.filter((s) => !s.dead).length;
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

// ── 70-view-table.js ───────────────────────────────────────────────────────────────
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
  // 不加 role="grid"：grid 角色向读屏器承诺一套完整的方格键盘导航
  // （方向键在单元格间移动），而这里并没有实现。承诺了不实现比不承诺更糟——
  // 读屏器会切到 grid 浏览模式，用户反而读不到表格内容。
  // 原生 <table> 语义本身就够用。
  table.setAttribute("aria-label", "站点对比表");

  // ── 表头（aria-sort 标记当前排序列）─────────────────────────────────────────
  const sortColMap = { fresh: "col-fresh", quota: "col-quota", community: "col-community", name: "col-name" };
  const activeSortCol = sortColMap[state.sortBy] || "col-fresh";
  // 方向要跟真实排序一致：按名称是 localeCompare 升序，
  // 鲜度/额度/社区都是"最优先在前"，语义上是降序。
  const activeDir = state.sortBy === "name" ? "ascending" : "descending";
  const th = (cls, label) =>
    `<th scope="col" class="${cls}" aria-sort="${cls === activeSortCol ? activeDir : "none"}">${label}</th>`;
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

    const label = (open) => `已失效 (${dead.length}) — 点击${open ? "折叠" : "展开"}`;
    const toggleRow = document.createElement("tr");
    toggleRow.className = "dead-toggle";
    // 按钮文字与 aria-expanded 必须由 state 推导：表格会因为筛选/排序反复重建，
    // 写死 "点击展开"/false 会在 showDead 已经是 true 时和实际状态对不上。
    toggleRow.innerHTML = `<td colspan="7">
      <button class="dead-toggle-btn" type="button" aria-expanded="${state.showDead}" aria-controls="deadGroup">
        ${label(state.showDead)}
      </button>
    </td>`;
    deadGroup.id = "deadGroup";
    toggleRow.querySelector("button").addEventListener("click", (e) => {
      state.showDead = !state.showDead;
      deadGroup.hidden = !state.showDead;
      e.currentTarget.setAttribute("aria-expanded", String(state.showDead));
      e.currentTarget.textContent = label(state.showDead);
    });
    tbody.appendChild(toggleRow);

    dead.forEach((site) => {
      const row = makeTableRow(site);
      row.classList.add("row-dead");
      deadGroup.appendChild(row);
    });
    // deadGroup 是 <tbody>，必须挂在 <table> 上而不是另一个 <tbody> 里面。
    // 原来 tbody.appendChild(deadGroup) 会造出 <tbody><tbody>…</tbody></tbody>
    // 这种非法嵌套（DOM 不拦，浏览器渲染行为无保证）。
    table.appendChild(tbody);
    table.appendChild(deadGroup);
  } else {
    table.appendChild(tbody);
  }

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
    <a href="${esc(site.url)}" target="_blank" rel="noopener" class="btn-visit" aria-label="访问 ${esc(site.name)}"${site.dead ? ' title="该站已被报死链"' : ''}>访问 →</a>
    <button class="btn-detail" data-site="${esc(site.name)}" aria-label="查看详情">⋯</button>
    <button class="btn-still-works" data-site="${esc(site.name)}" aria-label="标记还能用">👍</button>
    <button class="btn-reported-dead" data-site="${esc(site.name)}" aria-label="标记已失效">👎</button>
  </div>`;

  row.innerHTML = `<td>${nameHtml}</td><td>${quotaHtml}</td><td>${capHtml}</td><td>${thHtml}</td><td>${freshHtml}</td><td>${communityHtml}</td><td>${actionHtml}</td>`;

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

// ── 80-view-card.js ───────────────────────────────────────────────────────────────
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

/**
 * 额度变更历史的展示文案（docs/09 阶段 D："↓ 额度从 25 降到 10（3天前）"）
 * @param {object|null} h — { field, oldValue, newValue, changedAt }
 * @returns {string|null}
 */
function historyLabel(h) {
  if (!h || !h.field) return null;
  const fmt = (v) => (v === null || v === undefined || v === "" ? "未知" : v);
  let dir = "→";
  const oldN = Number(h.oldValue);
  const newN = Number(h.newValue);
  // 数值字段按大小定方向（额度升降是用户最关心的信号）
  if (h.oldValue !== null && h.newValue !== null && !Number.isNaN(oldN) && !Number.isNaN(newN)) {
    dir = oldN > newN ? "↓ 降到" : oldN < newN ? "↑ 升到" : "→ 变为";
  } else if (h.field === "quotaTier") {
    // 档位是有序的：high > mid > low，即使值本身不是数字也要能判断升降
    const rank = { high: 3, mid: 2, low: 1 };
    if (rank[h.oldValue] !== undefined && rank[h.newValue] !== undefined && rank[h.oldValue] !== rank[h.newValue]) {
      dir = rank[h.oldValue] > rank[h.newValue] ? "↓ 降到" : "↑ 升到";
    }
  }
  return `${dir} 额度 ${fmt(h.oldValue)} → ${fmt(h.newValue)}（${relativeTime(h.changedAt)}）`;
}

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
  // tier 类挂在容器上：与表格 .cell-quota 同构，档位配色由 styles.css 统一管
  const quota = document.createElement("div");
  quota.className = "card-quota"
    + (site.quotaTier === "high" ? " tier-high"
      : site.quotaTier === "mid" ? " tier-mid"
      : site.quotaTier === "low" ? " tier-low" : "");
  const tierLabel = { high: "⭐高额度", mid: "中额度", low: "低额度", none: "" };
  quota.innerHTML = `
    <span class="quota-main">${esc(quotaText(site))}</span>
    ${tierLabel[site.quotaTier] ? `<span class="tier-badge">${esc(tierLabel[site.quotaTier])}</span>` : ""}
  `;

  // ── 额度变化角标（site_history，docs/09 阶段 D）───────────────────────────
  // "↓ 额度降到 10（3天前）"——变化信号是决策信息，放额度下面而不是塞详情里
  const historyText = historyLabel(site.history);
  const historyTag = historyText
    ? `<div class="history-badge" title="${esc(historyText)}">${esc(historyText)}</div>`
    : "";

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
  if (site.dead) visitLink.title = "该站已被报死链";

  const detailBtn = document.createElement("button");
  detailBtn.type = "button";
  detailBtn.className = "btn-detail";
  detailBtn.textContent = "⋯ 详情";
  detailBtn.addEventListener("click", () => openDrawer(site));

  const voteBar = makeVoteBar(site.name);
  actions.append(visitLink, detailBtn, voteBar);

  // ── 组装 ────────────────────────────────────────────────────────────────────
  node.append(header, quota);
  if (historyTag) {
    const tagWrap = document.createElement("div");
    tagWrap.className = "card-history-wrap";
    tagWrap.innerHTML = historyTag;
    node.appendChild(tagWrap);
  }
  node.append(summary, markers, actions);
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
  if (existing) {
    // 直接 remove() 不会注销挂在 document 上的 keydown 监听器，必须先 cleanup
    if (typeof existing.__cleanup === "function") existing.__cleanup();
    existing.remove();
  }

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
    if (value === null || value === undefined || value === "—") return;
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    dl.append(dt, dd);
  });
  body.appendChild(dl);

  // 最近一次额度变化（site_history，docs/09 阶段 D）
  const historyText = historyLabel(site.history);
  if (historyText) {
    const changeRow = document.createElement("div");
    changeRow.className = "drawer-history";
    changeRow.textContent = "🕐 " + historyText;
    body.appendChild(changeRow);
  }

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
  //
  // 注意监听器的注销时机：onKey 挂在 document 上，如果只在 Escape 分支里注销，
  // 那么从 ✕ 按钮或点遮罩关闭时它会永久留在 document 上。开关几次抽屉之后，
  // 按一下 Escape 会把这些陈旧监听器全部触发，每个都执行 triggerEl.focus()
  // —— 焦点会跳到好几个抽屉之前的那一行。所以统一收敛到 cleanup()，
  // 并挂在 overlay 上让 closeDrawer 无论走哪条路径都能调到。
  const onKey = (e) => {
    if (e.key === "Escape") {
      closeDrawer(triggerEl);
      return;
    }
    if (e.key === "Tab") {
      const focusable = Array.from(
        drawer.querySelectorAll(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => !el.disabled && el.offsetParent !== null);
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
    if (!drawer.contains(e.target)) closeBtn.focus();
  };
  document.addEventListener("keydown", onKey);
  overlay.addEventListener("focusin", onFocusIn);
  overlay.__cleanup = () => {
    document.removeEventListener("keydown", onKey);
    overlay.removeEventListener("focusin", onFocusIn);
  };
}

function closeDrawer(triggerEl) {
  const overlay = document.querySelector(".drawer-overlay");
  if (overlay) {
    // 先注销监听器，再做退场动画：动画期间 overlay 还在 DOM 里，
    // 不注销的话这 300ms 内的 Tab/Escape 仍会被已经"关掉"的抽屉截获。
    if (typeof overlay.__cleanup === "function") overlay.__cleanup();
    overlay.classList.remove("open");
    setTimeout(() => overlay.remove(), 300);
  }
  state.drawerSite = null;
  // 恢复焦点到触发元素（a11y）
  if (triggerEl && typeof triggerEl.focus === "function") {
    triggerEl.focus();
  }
}

// ── 90-forms.js ───────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
// Toast 通知 + 提交表单 + 反馈系统
// ═══════════════════════════════════════════════════════════════════════════════

// ── Toast 通知（替代 9 处 alert）─────────────────────────────────────────────

/**
 * 显示 toast 通知
 * @param {string} msg - 提示文字
 * @param {string} type - "success" | "error" | "info"
 */
function toast(msg, type = "info") {
  // 移除已有 toast
  const existing = document.querySelector(".app-toast");
  if (existing) existing.remove();

  const el = document.createElement("div");
  el.className = `app-toast toast-${type}`;
  el.textContent = msg;
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  document.body.appendChild(el);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => el.classList.add("show"));
  });

  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 400);
  }, 3000);
}

// ── 快速反馈（表格行的 👍/👎 一键按钮）───────────────────────────────────────

const FEEDBACK_STORAGE_KEY = "sk-free-feedbacks";

function loadPersonalFeedbacks() {
  try {
    return JSON.parse(localStorage.getItem(FEEDBACK_STORAGE_KEY) || "{}");
  } catch { return {}; }
}

function savePersonalFeedbacks(record) {
  try { localStorage.setItem(FEEDBACK_STORAGE_KEY, JSON.stringify(record)); } catch {}
}

/**
 * 一键反馈（无需填文本，最低摩擦入口）
 * @param {string} siteName - 站点名称
 * @param {string} type - "still_works" | "reported_dead"
 */
async function quickFeedback(siteName, type) {
  const personalFeedbacks = loadPersonalFeedbacks();
  const key = `${siteName}:${type}`;
  if (personalFeedbacks[key]) {
    toast("您已反馈过该站点，感谢！", "info");
    return;
  }

  try {
    const res = await fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ siteName, type, content: "" })
    });
    const data = await res.json();
    if (data.ok) {
      personalFeedbacks[key] = true;
      savePersonalFeedbacks(personalFeedbacks);
      toast(type === "still_works" ? "👍 感谢确认！" : "👎 感谢已记录！", "success");
    } else {
      toast(data.error || "反馈失败", "error");
    }
  } catch {
    toast("网络错误，请稍后重试", "error");
  }
}

// ── 反馈模态框 ────────────────────────────────────────────────────────────────

function openFeedbackModal(siteName) {
  const modal = document.getElementById("feedbackModal");
  const nameEl = document.getElementById("feedbackSiteName");
  const contentEl = document.getElementById("feedbackContent");
  const typeGroup = document.getElementById("feedbackTypeGroup");
  const confirmBtn = document.getElementById("feedbackConfirmBtn");
  const charCount = document.getElementById("feedbackCharCount");

  if (!modal) return;

  // 重置表单
  nameEl.textContent = "站点：" + siteName;
  contentEl.value = "";
  charCount.textContent = "0";
  confirmBtn.disabled = false;
  confirmBtn.textContent = "提交反馈";
  modal.dataset.siteName = siteName;
  modal.dataset.feedbackType = "";

  typeGroup.querySelectorAll(".feedback-type-btn").forEach((btn) => {
    btn.classList.remove("is-active");
  });

  modal.showModal();
  contentEl.focus();
}

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

    if (!type) { toast("请选择反馈类型", "error"); return; }
    if (content.length < 2) { toast("反馈内容至少需要 2 个字符", "error"); return; }

    // 与 quickFeedback 一致的 per-type 重复检测：同一站点同一类型只允许一次
    const personalFeedbacks = loadPersonalFeedbacks();
    if (personalFeedbacks[`${siteName}:${type}`]) {
      toast("您已反馈过该类型，感谢！", "info");
      return;
    }

    confirmBtn.disabled = true;
    confirmBtn.textContent = "提交中...";

    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteName, type, content })
      });
      const data = await res.json();
      if (data.ok) {
        modal.close();
        const personalFeedbacks = loadPersonalFeedbacks();
        personalFeedbacks[`${siteName}:${type}`] = true;
        savePersonalFeedbacks(personalFeedbacks);
        toast("✅ 感谢您的反馈！", "success");
      } else {
        toast(data.error || "提交失败", "error");
      }
    } catch {
      toast("网络错误，请稍后重试", "error");
    } finally {
      confirmBtn.disabled = false;
      confirmBtn.textContent = "提交反馈";
    }
  });
}

// ── 提交站点表单 ──────────────────────────────────────────────────────────────

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
        toast("✅ " + (data.message || "提交成功，等待管理员审核"), "success");
      } else {
        toast(data.error || "提交失败", "error");
      }
    } catch {
      toast("网络错误，请稍后重试", "error");
    } finally {
      confirmBtn.disabled = false;
      confirmBtn.textContent = "提交审核";
    }
  });
}

// ── 99-boot.js ───────────────────────────────────────────────────────────────
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
    .filter((s) => !s.dead && s.enabled === 1 && s.verifiedAt)
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
