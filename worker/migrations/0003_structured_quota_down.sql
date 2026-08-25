-- ============================================================
-- 0003 回滚脚本（DOWN）— 表重建版，不依赖 SQLite 版本
-- ============================================================
-- ⚠️ 只在 0003_up 出问题时使用。
-- ⚠️ 会永久丢失 quota_* / verified_* / slug / kind / needs_proxy 的所有值。
--    checkin 原文不受影响（quota_raw 只是它的副本）。
--
-- 为什么用表重建而不用 ALTER TABLE DROP COLUMN：
--   DROP COLUMN 需要 SQLite ≥ 3.35（2021 年）。本机 3.32.2 上实测直接
--   报 "near DROP: syntax error"，而前面的 DROP INDEX 已经生效——
--   留下"索引没了、列还在"的半完成状态，比不回滚更糟。
--   表重建在所有 SQLite 版本上行为一致，且天然没有半完成状态。
--
-- 执行前务必先导出快照：
--   wrangler d1 execute SKFREE_DB --remote --command "SELECT * FROM sites;" --json > backup.json

-- ── 反向 STEP 5：feedbacks.type 收回三值 ─────────────────────
-- 会丢弃 still_works / reported_dead 记录（旧 CHECK 容不下）。
-- 先确认可丢弃：SELECT type, count(*) FROM feedbacks GROUP BY type;
CREATE TABLE feedbacks_old (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('error','correction','positive')),
  content TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','read','resolved')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO feedbacks_old (id, site_name, type, content, ip, status, created_at)
  SELECT id, site_name, type, content, ip, status, created_at FROM feedbacks
  WHERE type IN ('error','correction','positive');
DROP TABLE feedbacks;
ALTER TABLE feedbacks_old RENAME TO feedbacks;
CREATE INDEX IF NOT EXISTS idx_feedbacks_site ON feedbacks(site_name);
CREATE INDEX IF NOT EXISTS idx_feedbacks_status ON feedbacks(status);
CREATE INDEX IF NOT EXISTS idx_feedbacks_created ON feedbacks(created_at);

-- ── 反向 STEP 1-4：用 0001 基线结构重建 sites ────────────────
-- 注意：id 会被完整保留（显式 SELECT id），
-- 所以 votes / feedbacks 的 site_name 关联不受影响。
CREATE TABLE sites_old (
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

INSERT INTO sites_old (id, name, url, original_url, ref, tags, summary, enabled,
                       checkin, models, rate, register, notes, sort_order,
                       created_at, updated_at)
  SELECT id, name, url, original_url, ref, tags, summary, enabled,
         checkin, models, rate, register, notes, sort_order,
         created_at, updated_at
  FROM sites;

DROP TABLE sites;
ALTER TABLE sites_old RENAME TO sites;

-- 索引随 DROP TABLE 一起消失，重建 0001 的两个
CREATE INDEX IF NOT EXISTS idx_sites_enabled ON sites(enabled);
CREATE INDEX IF NOT EXISTS idx_sites_sort ON sites(sort_order);

-- 验证回滚：列数应为 16，行数应与回滚前一致
-- SELECT count(*) FROM pragma_table_info('sites');
-- SELECT count(*) FROM sites;
