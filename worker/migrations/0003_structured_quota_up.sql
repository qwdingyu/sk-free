-- ============================================================
-- 0003 数据结构化：额度字段拆分 + 鲜度 + 稳定键 + 反馈类型扩展
-- ============================================================
-- ⚠️ 执行前必读 docs/12 第 4 节。必须先备份，必须分 5 步逐步执行并逐步验证。
-- ⚠️ SQLite 不支持 ALTER TABLE ADD COLUMN IF NOT EXISTS —— 本文件不可重复执行。
-- ⚠️ D1 的 execute --file 不支持显式 BEGIN/COMMIT，中途失败会留下半完成状态。
--    因此本文件被切成 5 个独立 STEP，每步都可单独执行、单独验证。

-- ============================================================
-- STEP 1／5：新增列（全部可空，允许"未知"，避免 UNIQUE 冲突）
-- ============================================================
-- 为什么全部可空：
--  1) NOT NULL DEFAULT '' + UNIQUE INDEX 在第 2 行就会
--     报 "UNIQUE constraint failed"（已实测）
--  2) "未知"是这个领域的真实状态（needs_proxy 有 15 条无法确认），
--     用 NULL 表达未知比用 0 假装"不需要魔法"更诚实

ALTER TABLE sites ADD COLUMN slug TEXT;               -- 稳定键；NULL 允许多行共存
ALTER TABLE sites ADD COLUMN kind TEXT;               -- api_site|bot|account_pool|tool
ALTER TABLE sites ADD COLUMN quota_min REAL;          -- 每周期额度下限
ALTER TABLE sites ADD COLUMN quota_max REAL;          -- 每周期额度上限
ALTER TABLE sites ADD COLUMN quota_unit TEXT;         -- usd|cny|credit|coin|token|call
ALTER TABLE sites ADD COLUMN quota_period TEXT;       -- daily|weekly|once|none
ALTER TABLE sites ADD COLUMN quota_calls_est INTEGER; -- 估算可调用次数
ALTER TABLE sites ADD COLUMN quota_tier TEXT;         -- high|mid|low|none（跨单位排序唯一依据）
ALTER TABLE sites ADD COLUMN quota_raw TEXT;          -- 原始文本，永不丢失
ALTER TABLE sites ADD COLUMN needs_proxy INTEGER;     -- 1需要 0不需要 NULL未知
ALTER TABLE sites ADD COLUMN verified_at TEXT;        -- 最后验证时间（鲜度核心）
ALTER TABLE sites ADD COLUMN verified_by TEXT;        -- admin|healthcheck|community
ALTER TABLE sites ADD COLUMN health_fail_count INTEGER NOT NULL DEFAULT 0;
                                                     -- 连续失败计数；达阈值才停用

-- 验证 STEP 1：应输出 29
-- SELECT count(*) FROM pragma_table_info('sites');


-- ============================================================
-- STEP 2／5：保留原文 + 生成稳定键
-- ============================================================
-- quota_raw 先无条件保存 checkin 原文，任何后续解析都不会丢信息
UPDATE sites SET quota_raw = checkin WHERE quota_raw IS NULL;

-- slug 用 's' || id 保证唯一且确定；可读性由管理员后续单独维护。
-- 不从中文站名生成：18 条里 8 条是中文名，音译规则不确定，
-- 且一旦生成错误又建了 UNIQUE 索引，修正成本很高。
UPDATE sites SET slug = 's' || id WHERE slug IS NULL;

-- 验证 STEP 2：两个数都应为 0
-- SELECT (SELECT count(*) FROM sites WHERE slug IS NULL) AS null_slug,
--        (SELECT count(*) - count(DISTINCT slug) FROM sites) AS dup_slug;


-- ============================================================
-- STEP 3／5：建索引（必须在 STEP 2 backfill 之后）
-- ============================================================
CREATE UNIQUE INDEX IF NOT EXISTS idx_sites_slug ON sites(slug);
CREATE INDEX IF NOT EXISTS idx_sites_verified ON sites(verified_at);
CREATE INDEX IF NOT EXISTS idx_sites_tier ON sites(quota_tier);

-- 验证 STEP 3：应输出 3
-- SELECT count(*) FROM sqlite_master WHERE type='index'
--   AND name IN ('idx_sites_slug','idx_sites_verified','idx_sites_tier');


-- ============================================================
-- STEP 4／5：18 条现有数据的额度结构化回填
-- ============================================================
-- 数据来源：2026-08-25 线上 /api/sites 实测值，逐条人工核对。
-- needs_proxy 一律留 NULL（未知）—— 只有 2 条有"半DC"标签，
-- 其余 16 条无从判断。宁可显示"未知"也不猜（见 docs/12 原则三）。
-- kind 由标签和 URL 形态判定，已逐条核对。

-- ── 高额度（每日 ≥10 刀等值）──────────────────────────────
UPDATE sites SET kind='api_site', quota_min=25, quota_max=25, quota_unit='usd',
  quota_period='daily', quota_tier='high' WHERE name='AgentRouter';
UPDATE sites SET kind='api_site', quota_min=25, quota_max=25, quota_unit='usd',
  quota_period='daily', quota_tier='high' WHERE name='AnyRouter';
UPDATE sites SET kind='api_site', quota_min=15, quota_max=15, quota_unit='usd',
  quota_period='daily', quota_tier='high' WHERE name='日月API';

-- ── 中额度 ────────────────────────────────────────────────
UPDATE sites SET kind='api_site', quota_min=10, quota_max=20, quota_unit='cny',
  quota_period='daily', quota_tier='mid' WHERE name='哈基米API站';
UPDATE sites SET kind='api_site', quota_min=100, quota_max=100, quota_unit='credit',
  quota_period='daily', quota_calls_est=60, quota_tier='mid' WHERE name='斑马API';
UPDATE sites SET kind='api_site', quota_min=50, quota_max=100, quota_unit='token',
  quota_period='daily', quota_tier='mid' WHERE name='星见雅API';
UPDATE sites SET kind='api_site', quota_min=2, quota_max=2, quota_unit='usd',
  quota_period='daily', quota_tier='mid' WHERE name='BizDecipher';
UPDATE sites SET kind='api_site', quota_min=2, quota_max=2, quota_unit='usd',
  quota_period='daily', quota_tier='mid' WHERE name='万象灵算';

-- ── 小额度 ────────────────────────────────────────────────
UPDATE sites SET kind='api_site', quota_min=0.5, quota_max=1, quota_unit='usd',
  quota_period='daily', quota_tier='low' WHERE name='CaMeL Al';
UPDATE sites SET kind='api_site', quota_min=0.5, quota_max=0.5, quota_unit='usd',
  quota_period='daily', quota_tier='low' WHERE name='AIAIAI工具箱';
UPDATE sites SET kind='bot', quota_min=1, quota_max=5, quota_unit='credit',
  quota_period='daily', quota_tier='low' WHERE name='公益Plus机器人';
UPDATE sites SET kind='api_site', quota_min=1, quota_max=3, quota_unit='coin',
  quota_period='daily', quota_tier='low' WHERE name='可萌中转站';

-- ── 一次性／无签到 ────────────────────────────────────────
UPDATE sites SET kind='api_site', quota_period='once', quota_tier='none'
  WHERE name='Cavoti API';
UPDATE sites SET kind='api_site', quota_period='once', quota_tier='none'
  WHERE name='huihuiyun';
UPDATE sites SET kind='api_site', quota_period='none', quota_tier='none'
  WHERE name='云舟API';
UPDATE sites SET kind='account_pool', quota_period='none', quota_tier='none'
  WHERE name='BOTCF';
UPDATE sites SET kind='bot', quota_period='none', quota_tier='none'
  WHERE name='BUG TEAM机器人';
UPDATE sites SET kind='tool', quota_period='none', quota_tier='none'
  WHERE name='localhost.cc';

-- 兜底：任何未被上面覆盖的行（将来新增的）给出安全默认值
UPDATE sites SET kind='api_site' WHERE kind IS NULL;
UPDATE sites SET quota_tier='none' WHERE quota_tier IS NULL;
UPDATE sites SET quota_period='none' WHERE quota_period IS NULL;

-- 验证 STEP 4：应为 0 未分类，且 tier 分布 high=3 mid=5 low=4 none=6
-- SELECT quota_tier, count(*) FROM sites GROUP BY quota_tier ORDER BY quota_tier;
-- SELECT count(*) FROM sites WHERE kind IS NULL OR quota_tier IS NULL;


-- ============================================================
-- STEP 5／5：扩展 feedbacks.type 允许值（必须重建表）
-- ============================================================
-- SQLite 无法 ALTER 掉 CHECK 约束，只能重建。
-- 这一步单独放在最后：即使它失败，STEP 1-4 的成果也已生效且可用。
-- 现在 feedbacks 表几乎是空的，是重建成本最低的时刻。

CREATE TABLE feedbacks_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN
    ('error','correction','positive','still_works','reported_dead')),
  content TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','read','resolved')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO feedbacks_new (id, site_name, type, content, ip, status, created_at)
  SELECT id, site_name, type, content, ip, status, created_at FROM feedbacks;

DROP TABLE feedbacks;
ALTER TABLE feedbacks_new RENAME TO feedbacks;

CREATE INDEX IF NOT EXISTS idx_feedbacks_site ON feedbacks(site_name);
CREATE INDEX IF NOT EXISTS idx_feedbacks_status ON feedbacks(status);
CREATE INDEX IF NOT EXISTS idx_feedbacks_created ON feedbacks(created_at);

-- 验证 STEP 5：行数与重建前一致，且新 type 可插入
-- SELECT count(*) FROM feedbacks;
-- INSERT INTO feedbacks (site_name,type) VALUES ('AnyRouter','still_works');  -- 应成功
