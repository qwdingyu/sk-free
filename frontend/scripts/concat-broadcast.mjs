#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════════
// concat-broadcast.mjs — 把 broadcast/*.js 按序拼接为 main.js
//
// 背景：main.js 曾经是手工拼接的产物，改 broadcast/ 源码后忘记重新拼接，
// 导致线上跑旧代码（文档 17 的"双份真相"P0 问题）。本脚本把拼接写进
// 构建链，让"改源码 → npm run build → 生效"成为唯一路径。
//
// 用法：node scripts/concat-broadcast.mjs
// 由 package.json 的 build 命令调用：node scripts/concat-broadcast.mjs && vite build
// ═══════════════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(__dirname, "../src/broadcast");
const OUT_FILE = resolve(__dirname, "../src/main.js");

// 模块加载顺序（依赖关系：前面的模块定义全局，后面的模块消费）
const MODULE_ORDER = [
  "00-config.js",
  "10-state.js",
  "20-utils.js",
  "30-api.js",
  "40-vote.js",
  "50-theme.js",
  "60-filter.js",
  "70-view-table.js",
  "80-view-card.js",
  "90-forms.js",
  "99-boot.js",
];

// 文件头注释（保留，说明 main.js 是生成物）
const HEADER = `// 广播页面入口 — 导入所有广播模块并启动应用
// 要改前端行为，请改 frontend/src/broadcast/ 下的模块，然后跑 npm run build。
// 本文件由 scripts/concat-broadcast.mjs 自动生成，请勿手工编辑。
// Modules: ${MODULE_ORDER.join(", ")}
`;

// 校验所有模块都存在
for (const mod of MODULE_ORDER) {
  const p = resolve(SRC_DIR, mod);
  try {
    readFileSync(p, "utf8");
  } catch {
    console.error(`🚫 缺少模块文件: ${mod}`);
    process.exit(1);
  }
}

// 按序拼接
const parts = [HEADER];
for (const mod of MODULE_ORDER) {
  const content = readFileSync(resolve(SRC_DIR, mod), "utf8");
  parts.push(`// ── ${mod} ───────────────────────────────────────────────────────────────`);
  parts.push(content);
}

const output = parts.join("\n");
writeFileSync(OUT_FILE, output, "utf8");

console.log(`✅ main.js 已由 ${MODULE_ORDER.length} 个 broadcast 模块拼接生成 (${output.length} 字节)`);