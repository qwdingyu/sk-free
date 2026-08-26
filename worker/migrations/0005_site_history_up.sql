-- 0005_site_history_up.sql — 站点变更历史（docs/09 阶段 D：额度变化提示）
-- 记录额度相关字段的变化，供前端展示"↓ 额度从 25 降到 10（3天前）"
-- 每次 handleAdminUpdateSite 检测到 quota_min/quota_max/quota_unit/quota_tier/rate
-- 变化时插入一条；前端 /api/sites 每行内嵌最近一条（GROUP BY MAX(id)）

CREATE TABLE IF NOT EXISTS site_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_name TEXT NOT NULL,
  field TEXT NOT NULL,        -- quotaMin / quotaMax / quotaUnit / quotaTier / rate
  old_value TEXT,             -- 变化前（NULL 表示"从无到有"）
  new_value TEXT,             -- 变化后（NULL 表示"被清空/设为未知"）
  changed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_site_history_name ON site_history(site_name);
