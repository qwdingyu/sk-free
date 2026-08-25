// ═══════════════════════════════════════════════════════════════════════════════
// 全局状态 + URL 同步
// ═══════════════════════════════════════════════════════════════════════════════
const state = {
  sites: [],          // 全量站点数据（从 API 获取）
  metadata: {},       // { total, enabled, dead, updatedAt }
  activePreset: "",   // 当前快捷视图名称（空 = 全部）
  activeTag: "",      // 当前标签筛选（空 = 全部）
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
  if (p.has("sort"))  state.sortBy = p.get("sort");
  if (p.has("q"))     state.query = p.get("q");
  if (p.has("preset")) state.activePreset = p.get("preset");
  if (p.has("tier"))  state.filterTier = p.get("tier").split(",").filter(Boolean);
  if (p.has("cap"))   state.filterCapability = p.get("cap").split(",").filter(Boolean);
  if (p.has("kind"))  state.filterKind = p.get("kind").split(",").filter(Boolean);
  if (p.has("fresh")) state.hideStale = p.get("fresh") === "7";
}

// 将当前筛选状态写入 URL（不污染浏览器历史）
function syncToUrl(push) {
  const p = new URLSearchParams();
  if (state.viewMode !== "table") p.set("view", state.viewMode);
  if (state.sortBy !== "fresh")   p.set("sort", state.sortBy);
  if (state.query)                p.set("q", state.query);
  if (state.activePreset)         p.set("preset", state.activePreset);
  if (state.filterTier.length)    p.set("tier", state.filterTier.join(","));
  if (state.filterCapability.length) p.set("cap", state.filterCapability.join(","));
  if (state.filterKind.length)    p.set("kind", state.filterKind.join(","));
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
