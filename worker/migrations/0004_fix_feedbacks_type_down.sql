-- ============================================================
-- 0004 回滚：恢复 feedbacks 表到3种 type
-- 仅当 still_works/dead 数据需要保留时才执行此脚本
-- 执行：wrangler d1 execute SKFREE_DB --remote --file=worker/migrations/0004_fix_feedbacks_type_down.sql
-- ============================================================

CREATE TABLE feedbacks_old (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('error', 'correction', 'positive')),
  content TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new', 'read', 'resolved')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 只迁移仍然是3种类型的行（still_works/dead 的行会丢失）
INSERT INTO feedbacks_old (id, site_name, type, content, ip, status, created_at)
SELECT id, site_name, type, content, ip, status, created_at FROM feedbacks
WHERE type IN ('error', 'correction', 'positive');

DROP TABLE feedbacks;
ALTER TABLE feedbacks_old RENAME TO feedbacks;

CREATE INDEX IF NOT EXISTS idx_feedbacks_site ON feedbacks(site_name);
CREATE INDEX IF NOT EXISTS idx_feedbacks_status ON feedbacks(status);
CREATE INDEX IF NOT EXISTS idx_feedbacks_created ON feedbacks(created_at);
