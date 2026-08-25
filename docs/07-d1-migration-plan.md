# D1 迁移方案 — KV+JSON → D1

> 目标：将 sk-free 的 5 个 KV key 迁移到 Cloudflare D1，消除写放大，解除 1000 次/天写入限制。

---

## 一、迁移范围

### 迁移到 D1（5 个表）

| KV Key | D1 表名 | 行数估算（3000站点） | 迁移优先级 |
|--------|---------|---------------------|-----------|
| `sites.json` | `sites` | 3000 行 | 🔴 最高（写放大致命） |
| `votes.json` | `votes` | 3000 行 | 🟡 中等 |
| `rate_limits` | `rate_limit_windows` | 按 IP×站点 动态 | 🟡 中等 |
| `submissions.json` | `submissions` | ~100 行/天 | 🟢 低 |
| `dead_urls.json` | `dead_urls` | ~50 行 | 🟢 低 |

### 保留在 KV（1 个 key）

| KV Key | 原因 |
|--------|------|
| `schema.json` | 极少写入（几乎不改），单 key 读取 KV 更简单 |

---

## 二、D1 表设计

借鉴 cf-shop 的 `migrations/0001_init.sql` 模式（UP/DOWN 结构）。

```sql
-- migrations/0001_init.sql

-- ============================================================
-- sites — 站点数据（核心表）
-- ============================================================
CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,           -- 站点名，业务主键
  url TEXT NOT NULL DEFAULT '',        -- 干净 URL
  original_url TEXT NOT NULL DEFAULT '', -- 导入时保留的原始 URL
  ref TEXT NOT NULL DEFAULT '',        -- 被剥离的推广参数
  tags TEXT NOT NULL DEFAULT '[]',     -- JSON 数组序列化
  summary TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,  -- boolean → 0/1
  checkin TEXT NOT NULL DEFAULT '',
  models TEXT NOT NULL DEFAULT '',
  rate TEXT NOT NULL DEFAULT '',
  register TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '[]',    -- JSON 数组序列化
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sites_enabled ON sites(enabled);
CREATE INDEX IF NOT EXISTS idx_sites_sort ON sites(sort_order);

-- ============================================================
-- votes — 投票数据
-- ============================================================
CREATE TABLE IF NOT EXISTS votes (
  site_name TEXT PRIMARY KEY,          -- 关联 sites.name
  up_count INTEGER NOT NULL DEFAULT 0,
  down_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- rate_limit_windows — 投票速率限制（借鉴 cf-shop 模式）
-- ============================================================
CREATE TABLE IF NOT EXISTS rate_limit_windows (
  action TEXT NOT NULL,                -- 'vote'
  subject TEXT NOT NULL,               -- site_name
  ip_hash TEXT NOT NULL,               -- 哈希后的 IP
  window_start INTEGER NOT NULL,       -- 窗口起始时间戳
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (action, subject, ip_hash, window_start)
);
CREATE INDEX IF NOT EXISTS idx_rlwindows_cleanup ON rate_limit_windows(window_start);

-- ============================================================
-- submissions — 用户提交待审核队列
-- ============================================================
CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,                 -- 'timestamp-random'
  site_name TEXT NOT NULL DEFAULT '',
  site_url TEXT NOT NULL DEFAULT '',
  site_tags TEXT NOT NULL DEFAULT '[]',
  site_summary TEXT NOT NULL DEFAULT '',
  site_checkin TEXT NOT NULL DEFAULT '',
  site_models TEXT NOT NULL DEFAULT '',
  site_register TEXT NOT NULL DEFAULT '',
  site_notes TEXT NOT NULL DEFAULT '[]',
  ip TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);

-- ============================================================
-- dead_urls — 死链接黑名单
-- ============================================================
CREATE TABLE IF NOT EXISTS dead_urls (
  url TEXT PRIMARY KEY,
  added_at INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT ''
);
```

---

## 三、可复用的 cf-shop 模式

> **注意**：cf-shop 使用 Turso/libSQL + Drizzle ORM（TypeScript）。sk-free 是 plain JS 项目，直接用 D1 原生 SQL，不引入 ORM。

### 3.1 迁移文件结构（直接 cp）

cf-shop 的 `migrations/` 目录包含 37 个 SQL 文件，每个文件有 `-- UP` 和 `-- DOWN` 段。直接复用此结构：

```
worker/
  migrations/
    0001_init.sql          ← 新建（借鉴 cf-shop 0001_init.sql 结构）
  src/
    db.js                  ← 新建（D1 查询封装，参考 cf-shop db/database.ts 的 isolate 缓存模式）
```

### 3.2 速率限制表设计（简化版）

cf-shop 的 `rate_limit_windows` 表使用 `(action, ip_hash, window_start)` 复合主键 + 滑动窗口计数。sk-free 简化为固定窗口：

```sql
-- cf-shop 模式（滑动窗口，复杂但精确）
CREATE TABLE rate_limit_windows (
  action TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (action, ip_hash, window_start)
);

-- sk-free 简化版（固定窗口，够用）
CREATE TABLE rate_limits (
  site_name TEXT NOT NULL,
  ip TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  PRIMARY KEY (site_name, ip, window_start)
);
```

### 3.3 wrangler.toml D1 绑定

```toml
[[d1_databases]]
binding = "SKFREE_DB"
database_name = "sk-free-db"
database_id = "<创建后填入>"
```

### 3.4 D1 查询封装（参考 cf-shop database.ts 的 isolate 缓存）

```javascript
// worker/src/db.js — D1 查询封装
// 参考 cf-shop src/db/database.ts 的 isolate 级缓存模式

let _cachedDb = null;

export function getDb(env) {
  if (_cachedDb) return _cachedDb;
  _cachedDb = env.SKFREE_DB; // D1 binding
  return _cachedDb;
}

// 通用查询封装
export async function dbAll(db, sql, args = []) {
  const result = await db.prepare(sql).bind(...args).all();
  return result.results;
}

export async function dbRun(db, sql, args = []) {
  return await db.prepare(sql).bind(...args).run();
}

export async function dbGet(db, sql, args = []) {
  const result = await db.prepare(sql).bind(...args).first();
  return result || null;
}
```

---

## 四、代码改造清单

### 4.1 新增文件

| 文件 | 说明 |
|------|------|
| `worker/migrations/0001_init.sql` | D1 建表 SQL |
| `worker/src/db.js` | D1 查询封装（参考 cf-shop 的 `db/client.ts`） |

### 4.2 修改文件：`worker/index.js`

| 改动点 | 当前（KV） | 改为（D1） |
|--------|-----------|-----------|
| Env bindings | `SKFREE_KV` | `SKFREE_DB` (D1) |
| `handleGetSites()` | `kv.get(SITES_KEY)` → JSON.parse → 返回 | `db.prepare("SELECT * FROM sites ORDER BY sort_order").all()` |
| `handleAddSite()` | 读全量 → push → 写全量 | `db.prepare("INSERT INTO sites ...").run()` |
| `handleUpdateSite()` | 读全量 → find → 写全量 | `db.prepare("UPDATE sites SET ... WHERE name=?").run()` |
| `handleDeleteSite()` | 读全量 → filter → 写全量 | `db.prepare("DELETE FROM sites WHERE name=?").run()` |
| `handleBatchSites()` | 读全量 → 批量操作 → 写全量 | D1 批量 INSERT/UPDATE/DELETE |
| `handleImportSites()` | 读全量 → 合并 → 写全量 | D1 批量 INSERT OR REPLACE |
| `handleVote()` | 读 votes → update → 写全量 | `db.prepare("INSERT INTO votes ... ON CONFLICT DO UPDATE SET up_count=up_count+1").run()` |
| 投票速率限制 | KV 全量重写 rate_limits | `db.prepare("INSERT INTO rate_limit_windows ...").run()` |
| `handleSubmit()` | 读 submissions → push → 写全量 | `db.prepare("INSERT INTO submissions ...").run()` |
| `loadDeadUrls()` | `kv.get(DEAD_URLS_KEY)` | `db.prepare("SELECT * FROM dead_urls").all()` |
| `saveDeadUrls()` | `kv.put(DEAD_URLS_KEY, ...)` | D1 批量 INSERT/DELETE |

### 4.3 保留不动

| 功能 | 原因 |
|------|------|
| `schema.json` (KV) | 极少写入，单 key 场景 KV 更简单 |
| 所有前端代码 | API 接口不变，前端零改动 |
| 认证逻辑 | 不涉及数据存储 |

---

## 五、数据迁移脚本

### 方案 A：Worker 内迁移端点（推荐，零停机）

在 Worker 中添加一次性迁移端点，部署后调用一次即可：

```javascript
// POST /api/admin/migrate-kv-to-d1（运行一次后删除）
// 从 KV 读取 → 解析 JSON → 批量写入 D1 → 验证行数
if (path === "/api/admin/migrate-kv-to-d1" && request.method === "POST") {
  const authError = await checkAuth(request, env);
  if (authError) return authError;

  const db = env.SKFREE_DB;
  const kv = env.SKFREE_KV;
  const report = {};

  // 1. 迁移 sites.json
  const sitesRaw = await kv.get("sites.json");
  const sitesData = sitesRaw ? JSON.parse(sitesRaw) : { sites: [] };
  for (const s of sitesData.sites) {
    await db.prepare(`INSERT OR REPLACE INTO sites
      (name, url, original_url, ref, tags, summary, enabled, checkin, models, rate, register, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      s.name, s.url, s.originalUrl || "", s.ref || "",
      JSON.stringify(s.tags || []), s.summary || "",
      s.enabled !== false ? 1 : 0,
      s.checkin || "", s.models || "", s.rate || "",
      s.register || "", JSON.stringify(s.notes || [])
    ).run();
  }
  report.sites = sitesData.sites.length;

  // 2. 迁移 votes.json
  const votesRaw = await kv.get("votes.json");
  const votes = votesRaw ? JSON.parse(votesRaw) : {};
  for (const [name, v] of Object.entries(votes)) {
    await db.prepare(`INSERT OR REPLACE INTO votes (site_name, up_count, down_count)
      VALUES (?, ?, ?)`).bind(name, v.up || 0, v.down || 0).run();
  }
  report.votes = Object.keys(votes).length;

  // 3. 迁移 dead_urls.json
  const deadRaw = await kv.get("dead_urls.json");
  let deadUrls = deadRaw ? JSON.parse(deadRaw) : {};
  if (deadUrls.deadUrls && typeof deadUrls.deadUrls === "object") deadUrls = deadUrls.deadUrls;
  for (const [url, info] of Object.entries(deadUrls)) {
    await db.prepare(`INSERT OR REPLACE INTO dead_urls (url, added_at, status, reason, error)
      VALUES (?, ?, ?, ?, ?)`).bind(
      url, info.addedAt || 0, info.status || 0,
      info.reason || "", info.error || ""
    ).run();
  }
  report.deadUrls = Object.keys(deadUrls).length;

  // 4. 迁移 submissions.json
  const subsRaw = await kv.get("submissions.json");
  const subs = subsRaw ? JSON.parse(subsRaw) : [];
  for (const sub of subs) {
    const site = sub.site || {};
    await db.prepare(`INSERT OR REPLACE INTO submissions
      (id, site_name, site_url, site_tags, site_summary, site_checkin, site_models, site_register, site_notes, ip, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      sub.id, site.name || "", site.url || "",
      JSON.stringify(site.tags || []), site.summary || "",
      site.checkin || "", site.models || "",
      site.register || "", JSON.stringify(site.notes || []),
      sub.ip || "", sub.status || "pending",
      sub.createdAt ? new Date(sub.createdAt).toISOString() : new Date().toISOString()
    ).run();
  }
  report.submissions = subs.length;

  // 5. schema.json 保留在 KV，不动

  return json({ ok: true, report }, 200, request);
}
```

### 方案 B：wrangler CLI 脚本（备选）

```bash
# 从 KV 导出 → 生成 SQL → 执行到 D1
wrangler kv key get "sites.json" --namespace-id <KV_ID> > /tmp/sites.json
# 用 node 脚本转换为 INSERT SQL
node scripts/kv-to-d1-migrate.js > /tmp/migrate.sql
wrangler d1 execute sk-free-db --file=/tmp/migrate.sql
```

---

## 六、部署步骤

```
Phase 1: 准备（不中断服务）
├── 1. 创建 D1 数据库: wrangler d1 create sk-free-db
├── 2. 执行建表: wrangler d1 execute sk-free-db --file=migrations/0001_init.sql
├── 3. 添加 D1 binding 到 wrangler.toml
├── 4. 部署新版 Worker（同时保留 KV binding）
└── 5. 运行迁移端点，将 KV 数据写入 D1

Phase 2: 切换（秒级中断）
├── 6. 验证 D1 数据完整性
├── 7. 代码中将所有 KV 读写替换为 D1
├── 8. 部署切换版本
└── 9. 验证所有端点正常

Phase 3: 清理（可选）
├── 10. 保留 KV 30 天作为回退
└── 11. 30 天后删除 KV namespace
```

---

## 七、风险与回退

| 风险 | 缓解措施 |
|------|---------|
| D1 写入失败 | 保留 KV binding，代码可快速回退 |
| 数据迁移不完整 | 迁移脚本验证行数 + 抽样校验 |
| D1 延迟高于 KV | D1 读取延迟 ~10ms，与 KV 相当 |
| 并发写入冲突 | D1 支持事务 + WAL 模式，比 KV 全量重写更安全 |

---

## 八、工作量估算

| 阶段 | 工作量 | 说明 |
|------|--------|------|
| SQL schema 设计 | 0.5h | 借鉴 cf-shop 模式 |
| D1 查询封装 | 1h | 参考 cf-shop db/client.ts |
| Worker 代码改造 | 3-4h | 20+ 处 KV→D1 替换 |
| 数据迁移脚本 | 1h | KV 导出 → D1 导入 |
| 测试验证 | 2h | 逐端点验证 |
| **总计** | **8-9h** | |

---

## 九、迁移后收益

| 指标 | 迁移前（KV） | 迁移后（D1） |
|------|-------------|-------------|
| 编辑 1 站点 | 重写 1.2MB JSON | 单行 UPDATE |
| 每日写入上限 | 1,000 次 | 100,000 次 |
| 每日读取上限 | 100,000 次 | 5,000,000 次 |
| 数据损坏风险 | 高（写中崩溃=全量丢失） | 低（事务保护） |
| 并发安全 | 无（last-write-wins） | 有（WAL + 事务） |
