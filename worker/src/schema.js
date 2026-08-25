// ═══════════════════════════════════════════════════════════════════════════════
// schema.js — Schema 配置管理（保留 KV 存储）
// schema.json 极少写入，单 key 场景 KV 比 D1 更简单
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 默认 Schema — 定义站点所有字段的元信息
 * 包含：fields（字段定义）、tags（标签枚举）、display（前端显示配置）
 */
export const DEFAULT_SCHEMA = {
  fields: [
    { key: "name", label: "站点名称", type: "text", required: true },
    { key: "url", label: "站点 URL", type: "url", required: true },
    { key: "tags", label: "标签", type: "tags", required: false },
    { key: "summary", label: "简介", type: "textarea", required: false },
    { key: "checkin", label: "签到", type: "text", required: false },
    { key: "models", label: "支持模型", type: "text", required: false },
    { key: "rate", label: "限速", type: "text", required: false },
    { key: "register", label: "注册", type: "url", required: false },
    { key: "notes", label: "备注", type: "list", required: false },
  ],
  tags: ["免费", "需注册", "需魔法", "可签到", "限时免费"],
  display: {
    showTags: true,
    showSummary: true,
    showCheckin: true,
    showModels: true,
    showRate: true,
    showRegister: true,
    showNotes: false,
    showVotes: true,
    showUrl: true,
  },
  submit: { enabled: true, requireLogin: false },
  healthCheck: { enabled: true, intervalMinutes: 30 },
  theme: { defaultMode: "system", allowToggle: true },
};

/**
 * 获取 Schema 配置（优先读 KV，不存在则返回默认值并写入）
 * @param {object} kv — KV 命名空间绑定
 * @returns {Promise<object>} Schema 对象
 */
export async function getSchema(kv) {
  const raw = await kv.get("schema.json");
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch {
      // JSON 损坏，回退到默认值
    }
  }
  // 首次访问：写入默认 Schema
  await kv.put("schema.json", JSON.stringify(DEFAULT_SCHEMA));
  return DEFAULT_SCHEMA;
}

/**
 * 保存 Schema 配置到 KV
 * @param {object} kv — KV 命名空间绑定
 * @param {object} schema — 新的 Schema 对象
 */
export async function saveSchema(kv, schema) {
  await kv.put("schema.json", JSON.stringify(schema));
}
