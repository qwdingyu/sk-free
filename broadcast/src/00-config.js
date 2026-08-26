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
