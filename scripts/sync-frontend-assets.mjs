import { cpSync, existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

/*
 * 将 Vite 构建产物发布到 Worker Static Assets 目录。
 *
 * Worker 运行时读取的是 public/_app/index.html 和 public/_app/assets/*，
 * 而 Vite 构建输出在 frontend/dist。没有这一步时，本地 build 虽然成功，
 * 线上 SPA 入口会缺失，导致前端交付断层。
 */

const sourceDir = join("frontend", "dist");
const targetDir = join("worker", "public", "_app");

if (!existsSync(join(sourceDir, "index.html"))) {
  console.error("frontend/dist/index.html 不存在，请先执行 npm run build");
  process.exit(1);
}

rmSync(targetDir, { recursive: true, force: true });
mkdirSync(targetDir, { recursive: true });
cpSync(sourceDir, targetDir, { recursive: true });

// 注入构建标识：确保 index.html 中有且仅有一个 build hash 注释
// 供 deploy.sh 的 verify-deploy.sh 验证线上版本
const indexPath = join(targetDir, "index.html");
const indexContent = readFileSync(indexPath, "utf-8");
// 先移除旧的 build 注释（如果有），避免重复插入
const cleaned = indexContent.replace(/\n?\s*<!-- build:[a-f0-9]+ -->/g, "");
const buildHash = createHash("sha256").update(cleaned).digest("hex").slice(0, 12);
const patched = cleaned.replace(/<html[^>]*>/i, (m) => `${m}\n    <!-- build:${buildHash} -->`);
writeFileSync(indexPath, patched, "utf-8");
console.log(`✅ 构建标识已注入: build:${buildHash}`);

console.log("frontend assets synced to public/_app");
