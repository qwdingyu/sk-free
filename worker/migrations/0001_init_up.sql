-- ============================================================
-- 0001 初始化基线 — KV→D1 迁移（仅 UP，用于 wrangler d1 execute）
-- ============================================================

-- sites — 站点数据（核心表）
CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  url TEXT NOT NULL DEFAULT '',
  original_url TEXT NOT NULL DEFAULT '',
  ref TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  checkin TEXT NOT NULL DEFAULT '',
  models TEXT NOT NULL DEFAULT '',
  rate TEXT NOT NULL DEFAULT '',
  register TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '[]',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sites_enabled ON sites(enabled);
CREATE INDEX IF NOT EXISTS idx_sites_sort ON sites(sort_order);

-- votes — 投票数据
CREATE TABLE IF NOT EXISTS votes (
  site_name TEXT PRIMARY KEY,
  up_count INTEGER NOT NULL DEFAULT 0,
  down_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- rate_limits — 投票速率限制
CREATE TABLE IF NOT EXISTS rate_limits (
  site_name TEXT NOT NULL,
  ip TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  PRIMARY KEY (site_name, ip, window_start)
);

-- submissions — 用户提交待审核队列
CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  site_name TEXT NOT NULL DEFAULT '',
  site_url TEXT NOT NULL DEFAULT '',
  site_tags TEXT NOT NULL DEFAULT '[]',
  site_summary TEXT NOT NULL DEFAULT '',
  site_checkin TEXT NOT NULL DEFAULT '',
  site_models TEXT NOT NULL DEFAULT '',
  site_register TEXT NOT NULL DEFAULT '',
  site_notes TEXT NOT NULL DEFAULT '[]',
  ip TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);

-- dead_urls — 死链接黑名单
CREATE TABLE IF NOT EXISTS dead_urls (
  url TEXT PRIMARY KEY,
  added_at INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT ''
);
