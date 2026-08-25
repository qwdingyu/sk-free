#!/usr/bin/env node
/**
 * check-css-coverage.js — 检查前端 JS 产出的 class 是否都有 CSS 规则
 *
 * 为什么需要它：
 *   详情抽屉的 .drawer-overlay / .drawer / .drawer-close / .drawer-title
 *   在 CSS 里完全没有规则（只有 .drawer-notes / .drawer-vote / .drawer-feedback
 *   和一条藏在媒体查询里的 .drawer）。后果是点「⋯」之后，一个没有定位的
 *   普通 div 被追加到 body 末尾 —— 内容出现在页脚下方，没有遮罩没有动画，
 *   用户感觉"点了没反应"。JS 不报错，CSS 也不报错，只有肉眼在真实浏览器里
 *   才看得出来 —— 而肉眼恰好最容易漏掉这种"下方才出现"的元素。
 *
 * 做法：
 *   扫 broadcast/src/*.js 里出现的 class 名（className 赋值、classList 操作、
 *   模板里的 class="..."），逐个在 broadcast/styles.css 里找 .foo 选择器。
 *
 * 局限：
 *   纯文本匹配，不解析 CSS。只能回答"有没有写过这个选择器"，
 *   不能回答"样式对不对"。够用了 —— 缺失才是灾难，写错通常肉眼可见。
 */
import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(ROOT, "broadcast", "src");
const css = readFileSync(join(ROOT, "broadcast", "styles.css"), "utf-8");

// 故意不写样式的 class：语义钩子、测试选择器、或由更具体的组合选择器覆盖
const ALLOW = new Set([
  "is-active",      // 状态修饰，总是跟在具体 class 后面（.filter-chip.is-active）
  "open",           // 同上（.drawer-overlay.open）
  "positive", "negative",
  "hidden",
  "dim",
  "name", "quota", "cap", "fresh", "action", // 骨架屏单元格修饰
  "tier-high", "tier-mid", "tier-low",
]);

const found = new Map(); // class -> [file:line]
for (const f of readdirSync(SRC_DIR).filter((x) => x.endsWith(".js")).sort()) {
  readFileSync(join(SRC_DIR, f), "utf-8").split("\n").forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
    // 先把 ${...} 插值替换成空格，否则 class="vote-score-inline${cls}" 这类
    // 写法会被整段跳过 —— 而它恰好就是漏了样式的那一个。
    const clean = line.replace(/\$\{[^}]*\}/g, " ");
    const hits = [];
    // className = "a b c"  /  className = "a" + (x ? " b" : "")
    for (const m of clean.matchAll(/className\s*=\s*"([^"]*)"/g)) hits.push(...m[1].split(/\s+/));
    for (const m of clean.matchAll(/classList\.(?:add|toggle|remove)\(\s*"([^"]*)"/g)) hits.push(...m[1].split(/\s+/));
    // class="a b"
    for (const m of clean.matchAll(/class="([^"]*)"/g)) hits.push(...m[1].split(/\s+/));
    for (const c of hits) {
      const name = c.trim();
      if (!name || ALLOW.has(name)) continue;
      if (!/^[a-z][a-z0-9-]*$/.test(name)) continue; // 跳过插值残渣
      if (!found.has(name)) found.set(name, `${f}:${i + 1}`);
    }
  });
}

const missing = [];
for (const [name, where] of found) {
  // 匹配 .name 后面紧跟合法的选择器终止符
  const re = new RegExp(`\\.${name.replace(/[-]/g, "\\-")}(?![a-zA-Z0-9_-])`);
  if (!re.test(css)) missing.push({ name, where });
}

console.log(`🎨 前端 JS 产出 ${found.size} 个 class，styles.css 覆盖 ${found.size - missing.length} 个`);

if (missing.length === 0) {
  console.log("✅ check-css-coverage: 所有 class 都有对应的 CSS 规则");
  process.exit(0);
}

console.error(`\n❌ check-css-coverage: ${missing.length} 个 class 在 styles.css 里没有任何规则\n`);
for (const m of missing) console.error(`  .${m.name}   （产出于 ${m.where}）`);
console.error("\n要么补样式，要么把确实不需要样式的加入本脚本的 ALLOW 白名单。");
process.exit(1);
