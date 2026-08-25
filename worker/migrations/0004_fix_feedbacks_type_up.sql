-- ============================================================
-- 0004 重建 feedbacks 表，扩展 type CHECK 约束
-- 新增 still_works/dead 两个类型，支持"还能用/已失效"一键反馈
-- SQLite 不支持 ALTER CHECK，必须整表重建
-- 执行：wrangler d1 execute SKFREE_DB --remote --file=worker/migrations/0004_fix_feedbacks_type_up.sql
-- 回滚：wrangler d1 execute SKFREE_DB --remote --file=worker/migrations/0004_fix_feedbacks_type_down.sql
-- ============================================================

-- 1. 创建新表（含扩展后的5种 type）
CREATE TABLE feedbacks_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('error', 'correction', 'positive', 'still_works', 'reported_dead')),
  content TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new', 'read', 'resolved')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 2. 迁移现有数据（如果有）
INSERT INTO feedbacks_new (id, site_name, type, content, ip, status, created_at)
SELECT id, site_name, type, content, ip, status, created_at FROM feedbacks;

-- 3. 替换旧表
DROP TABLE feedbacks;
ALTER TABLE feedbacks_new RENAME TO feedbacks;

-- 4. 重建索引
CREATE INDEX IF NOT EXISTS idx_feedbacks_site ON feedbacks(site_name);
CREATE INDEX IF NOT EXISTS idx_feedbacks_status ON feedbacks(status);
CREATE INDEX IF NOT EXISTS idx_feedbacks_created ON feedbacks(created_at);
