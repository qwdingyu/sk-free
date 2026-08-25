// ═══════════════════════════════════════════════════════════════════════════════
// db.js — D1 数据库查询封装
// 参考 cf-shop src/db/database.ts 的 isolate 级缓存模式
// ═══════════════════════════════════════════════════════════════════════════════

let _cachedDb = null;

/**
 * 获取 D1 数据库实例（缓存绑定，避免重复绑定）
 * @param {object} env — Worker 环境变量（包含 SKFREE_DB binding）
 * @returns {object} D1 数据库实例
 */
export function getDb(env) {
  if (_cachedDb) return _cachedDb;
  _cachedDb = env.SKFREE_DB;
  return _cachedDb;
}

/**
 * 执行查询，返回所有结果行
 * @param {object} db — D1 数据库实例
 * @param {string} sql — SQL 查询语句
 * @param {Array} args — 绑定参数
 * @returns {Promise<Array>} 结果行数组
 */
export async function dbAll(db, sql, args = []) {
  const result = await db.prepare(sql).bind(...args).all();
  return result.results;
}

/**
 * 执行查询，返回第一行（或 null）
 * @param {object} db — D1 数据库实例
 * @param {string} sql — SQL 查询语句
 * @param {Array} args — 绑定参数
 * @returns {Promise<object|null>} 第一行或 null
 */
export async function dbGet(db, sql, args = []) {
  const result = await db.prepare(sql).bind(...args).first();
  return result || null;
}

/**
 * 执行写入/更新/删除操作
 * @param {object} db — D1 数据库实例
 * @param {string} sql — SQL 语句
 * @param {Array} args — 绑定参数
 * @returns {Promise<object>} 执行结果（含 meta.changes）
 */
export async function dbRun(db, sql, args = []) {
  return await db.prepare(sql).bind(...args).run();
}

/**
 * 批量执行多条语句（D1 batch API，单次请求内原子执行）
 * @param {object} db — D1 数据库实例
 * @param {Array<object>} statements — 预编译语句数组（db.prepare(...).bind(...)）
 * @returns {Promise<object>} 批量执行结果
 */
export async function dbBatch(db, statements) {
  return await db.batch(statements);
}
