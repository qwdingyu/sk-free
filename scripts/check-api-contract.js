#!/usr/bin/env node
/**
 * check-api-contract.js — 校验前端读取的站点字段确实由后端产出
 *
 * 为什么需要这个脚本：
 *   2026-08-25 的阶段 B 前端重构把所有结构化字段写成了 snake_case
 *   （site.quota_tier / site.needs_proxy），而后端 formatSiteRow 产出的是
 *   camelCase（quotaTier / needsProxy）。JS 读不存在的属性得到 undefined、
 *   不抛错，于是：18/18 站点显示"额度未知"、两个快捷筛选恒命中 0、
 *   全部排序退化 —— 页面照样渲染，看起来一切正常。
 *
 *   这类"静默失效"靠人眼 review 很难抓，必须机器校验。
 *
 * 做法：
 *   1. 从 worker/src/sites.js 的 formatSiteRow() 提取产出字段
 *   2. 扫描 broadcast/src/*.js 里对站点对象的属性读取
 *   3. 读了后端不产出的字段 → 报错退出
 *
 * 配套：deploy.sh 在部署前调用
 */
import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ── 1. 提取后端产出的字段 ─────────────────────────────────────────────────────
const sitesJs = readFileSync(join(ROOT, "worker", "src", "sites.js"), "utf-8");
const fnStart = sitesJs.indexOf("function formatSiteRow(row)");
if (fnStart === -1) {
  console.error("❌ 在 worker/src/sites.js 里找不到 formatSiteRow()");
  process.exit(1);
}
// 取到函数结尾的 "\n}"
const fnEnd = sitesJs.indexOf("\n}", fnStart);
const fnBody = sitesJs.slice(fnStart, fnEnd);

const produced = new Set();
for (const m of fnBody.matchAll(/^\s{4}([a-zA-Z_][a-zA-Z0-9_]*):/gm)) {
  produced.add(m[1]);
}

// 在 formatSiteRow 之外、由调用点补上的字段
const ADDED_AT_CALLSITE = ["votes", "dead"];
for (const k of ADDED_AT_CALLSITE) produced.add(k);

if (produced.size < 10) {
  console.error(`❌ 只从 formatSiteRow 解析出 ${produced.size} 个字段，解析逻辑可能失效`);
  process.exit(1);
}

// ── 2. 扫描前端读取的字段 ─────────────────────────────────────────────────────
// 只认变量名明确指向站点对象的场景，避免把别的对象误判进来
const SITE_VARS = ["site", "s", "a", "b", "row"];
const SRC_DIR = join(ROOT, "broadcast", "src");
const srcFiles = readdirSync(SRC_DIR).filter((f) => f.endsWith(".js")).sort();

// 白名单：确实不是站点字段，或前端本地计算/DOM 属性
const ALLOW = new Set([
  // 数组/字符串/DOM 的方法与属性（变量名恰好叫 s/a/b）
  "length", "push", "map", "filter", "sort", "join", "trim", "includes", "toLowerCase",
  "toUpperCase", "replace", "split", "slice", "indexOf", "forEach", "some", "every",
  "textContent", "className", "classList", "dataset", "style", "value", "checked",
  "href", "title", "type", "id", "hidden", "disabled", "appendChild", "querySelector",
  "addEventListener", "setAttribute", "getAttribute", "remove", "append", "cloneNode",
  "content", "firstElementChild", "innerHTML", "children", "parentNode", "closest",
  "localeCompare", "toFixed", "padEnd", "padStart", "match", "test", "keys", "values",
  "entries", "reduce", "find", "findIndex", "concat", "reverse", "startsWith", "endsWith",
  "charAt", "substring", "repeat", "at", "flatMap", "trimStart", "trimEnd",
  // 前端本地状态
  "up", "down", "score", "_fresh", "_tier",
]);

const violations = [];
for (const f of srcFiles) {
  const lines = readFileSync(join(SRC_DIR, f), "utf-8").split("\n");
  lines.forEach((line, idx) => {
    // 跳过注释行
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;

    for (const v of SITE_VARS) {
      const re = new RegExp(`\\b${v}\\.([a-zA-Z_][a-zA-Z0-9_]*)`, "g");
      for (const m of line.matchAll(re)) {
        const field = m[1];
        if (ALLOW.has(field) || produced.has(field)) continue;
        // 方法调用（后面紧跟括号）一律跳过：不是数据字段
        const after = line.slice(m.index + m[0].length);
        if (after.startsWith("(")) continue;
        violations.push({ file: f, line: idx + 1, expr: `${v}.${field}`, text: trimmed });
      }
    }
  });
}

// ── 3. 报告 ───────────────────────────────────────────────────────────────────
console.log(`📋 后端 formatSiteRow 产出 ${produced.size} 个字段`);

if (violations.length === 0) {
  console.log(`✅ check-api-contract: broadcast/src/*.js 读取的字段全部由后端产出`);
  process.exit(0);
}

console.error(`\n❌ check-api-contract: 发现 ${violations.length} 处读取后端不产出的字段\n`);
for (const v of violations) {
  // 给出最可能的正确写法（snake_case → camelCase）
  const camel = v.expr.split(".")[1].replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const hint = produced.has(camel) ? `  → 应为 .${camel}` : "";
  console.error(`  ${v.file}:${v.line}  ${v.expr}${hint}`);
  console.error(`      ${v.text}`);
}
console.error(`\n后端产出的字段清单：\n  ${[...produced].sort().join(", ")}\n`);
console.error("若确实不是站点字段，请加入本脚本的 ALLOW 白名单。");
process.exit(1);
