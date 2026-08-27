#!/usr/bin/env node
/**
 * check-admin-html.mjs — 管理后台 HTML ↔ 模块 JS 一致性校验
 *
 * 为什么需要它（真实事故）：
 *   Vite 迁移时 frontend/admin.html 是凭记忆重写的简化骨架，与旧版
 *   getAdminHTML() 的正式页面差了 17 个被 JS 引用的元素和全部按钮事件属性，
 *   部署后线上登录按钮点击无效、确认弹窗直接抛错——构建链路全程绿灯。
 *   这类"HTML 与 JS 各改各的"错配不会报编译错误，必须机器比对。
 *
 * 校验三条不变量：
 *   1. admin-raw.js 里 getElementById 引用的每个 id 都存在于 admin.html
 *   2. admin.html 里每个 onclick="fn(...)" 引用的函数，在 admin-raw.js 中有定义
 *   3. 且该函数被 window 桥接（ES 模块顶层函数不挂 window）
 */
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const js = readFileSync(join(ROOT, "frontend/src/admin-raw.js"), "utf8");
const html = readFileSync(join(ROOT, "frontend/admin.html"), "utf8");

let fail = 0;

// ── 1. id 覆盖检查 ────────────────────────────────────────────────────────────
// 注意：部分 id 由 JS 自身动态注入后再读取（如 healthDeadCount 由
// renderHealthFromSites() 的 innerHTML 创建）——这类在 js 源码里能找到
// `id="xxx"` 字面量，不算缺失；只有 js 既没造、html 又没有的才是真缺失。
const usedIds = [...js.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1]);
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const missingIds = [...new Set(usedIds)]
  .filter((id) => !id.startsWith("drawer-title-"))
  .filter((id) => !htmlIds.has(id))
  .filter((id) => !js.includes(`id="${id}"`));
if (missingIds.length) {
  fail = 1;
  console.error(`❌ admin.html 缺少 ${missingIds.length} 个被 JS 引用的 id：`);
  missingIds.forEach((id) => console.error(`     #${id}`));
}

// ── 2. onclick 函数定义检查 ───────────────────────────────────────────────────
const onclickFns = [...new Set(
  [...html.matchAll(/onclick="([a-zA-Z_$][\w$]*)\(/g)].map((m) => m[1])
)];
const undefinedFns = onclickFns.filter(
  (n) => !new RegExp(`\\b(?:async\\s+)?function\\s+${n}\\b`).test(js)
);
if (undefinedFns.length) {
  fail = 1;
  console.error(`❌ onclick 引用了 admin-raw.js 未定义的函数：${undefinedFns.join(", ")}`);
}

// ── 3. window 桥接检查 ────────────────────────────────────────────────────────
const bridgeMatch = js.match(/Object\.assign\(window,\s*\{([\s\S]*?)\}\)/);
const bridged = new Set(
  bridgeMatch ? bridgeMatch[1].match(/[a-zA-Z_$][\w$]*/g).filter((n) => !["window", "Object", "assign"].includes(n)) : []
);
const unbridged = onclickFns.filter((n) => !bridged.has(n));
if (unbridged.length) {
  fail = 1;
  console.error(`❌ onclick 函数未桥接到 window（模块作用域点击即报错）：${unbridged.join(", ")}`);
}

if (fail === 0) {
  console.log(`✅ check-admin-html: ${usedIds.length} 个 id 引用全覆盖，${onclickFns.length} 个 onclick 函数已定义并桥接`);
  process.exit(0);
}
console.error("\n修复方式：admin.html 与 admin-raw.js 必须同源演化；onclick 清单变更时同步更新 window 桥接块。");
process.exit(1);
