-- ============================================================
-- 0002 添加用户反馈表（feedbacks）
-- 用户可在站点卡片提交反馈，admin 后台审核处理
-- 执行：wrangler d1 execute SKFREE_DB --remote --file=worker/migrations/0002_add_feedbacks_up.sql
-- ============================================================

-- feedbacks — 用户反馈（报错/纠正/好评）
CREATE TABLE IF NOT EXISTS feedbacks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('error', 'correction', 'positive')),
  content TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new', 'read', 'resolved')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_feedbacks_site ON feedbacks(site_name);
CREATE INDEX IF NOT EXISTS idx_feedbacks_status ON feedbacks(status);
CREATE INDEX IF NOT EXISTS idx_feedbacks_created ON feedbacks(created_at);
