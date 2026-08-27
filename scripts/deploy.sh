#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# deploy.sh — 安全部署脚本（含预检查）
#
# 使用方式：bash scripts/deploy.sh
# 替代直接运行：npx wrangler deploy
#
# 预检查任何一步失败都会阻止部署（set -e）。共 8 步：6 步预检查 + 部署 + 部署后验证。
# 检查顺序按"越便宜越靠前"排列，快速失败。
# ═══════════════════════════════════════════════════════════════════════════════

set -e
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "🔍 部署前检查..."
echo ""

# ── 1. 语法检查（最便宜，先跑）─────────────────────────────────────────────────
echo "1️⃣  语法检查..."
for f in "$PROJECT_DIR"/worker/index.js "$PROJECT_DIR"/worker/src/*.js; do
  node --check "$f" || { echo "🚫 语法错误：$f"; exit 1; }
done
echo "✅ Worker JS 语法通过"
echo ""

# ── 2. 前后端字段契约检查 ──────────────────────────────────────────────────────
# 前端读 site.quota_tier 而后端产出 quotaTier 这类问题不会抛错，
# 只会让页面静默显示"未知"。必须机器校验。
echo "2️⃣  前后端字段契约检查..."
node "$SCRIPT_DIR/check-api-contract.js"
echo ""

# ── 2.5 管理后台 HTML ↔ JS 一致性检查 ────────────────────────────────────────
# 拦截"id 被引用但 HTML 没有""onclick 调用未定义/未桥接的函数"——
# 这类错配构建全绿、上线后按钮才炸（真实发生过：登录按钮失效）。
echo "2️⃣5️⃣  管理后台 HTML ↔ JS 一致性检查..."
node "$SCRIPT_DIR/check-admin-html.mjs"
echo ""

# ── 3. CSS 覆盖检查 ────────────────────────────────────────────────────────────
# JS createElement 出的 class 如果没有对应 CSS 规则，元素会以无定位的
# 普通块渲染（抽屉就这样飘到了页脚下方），JS 和 CSS 都不会报错。
echo "3️⃣  CSS 覆盖检查..."
node "$SCRIPT_DIR/check-css-coverage.js"
echo ""

# ── 4. 构建前端（Vite）──────────────────────────────────────────────────────────
# 前端代码已迁移到 frontend/，用 Vite 构建到 frontend/dist/，然后同步到 public/_app/
echo "4️⃣  构建前端..."
cd "$PROJECT_DIR/frontend"
npm run build
cd "$PROJECT_DIR"
node "$SCRIPT_DIR/sync-frontend-assets.mjs"
echo ""

# ── 5. 前端行为回归测试（需要 jsdom，没装则自动跳过）──────────────────────────
# 拦的是"页面照样渲染、功能静默失效"那一类：字段错配、面板自己关掉、
# 死链分组不可达、监听器泄漏、时区偏差。
echo "5️⃣  前端行为回归测试..."
node "$SCRIPT_DIR/test-frontend.mjs"
echo ""

# ── 6. 前端构建验证 ─────────────────────────────────────────────────────────────
# Vite 构建已经保证了代码正确性，这里只做简单的产物存在性检查
echo "6️⃣  前端构建验证..."
if [ ! -f "$PROJECT_DIR/worker/public/_app/index.html" ]; then
  echo "🚫 前端产物缺失：worker/public/_app/index.html 不存在"
  exit 1
fi
echo "✅ 前端产物就绪"
echo ""

# ── 7. 后端改动提醒（不做静默跳过）─────────────────────────────────────────────
# 集成测试要真起一个 wrangler dev（约 15 秒）+ 本地 D1，不适合每次部署都跑。
# 但它拦的是只有打真实接口才能发现的那一类：合并语义看错导致静默数据丢失、
# 表单加了输入框但没发出去。所以 worker/ 有改动时明确提醒一次，
# 而不是假装检查过了。
if ! git -C "$PROJECT_DIR" diff --quiet HEAD -- worker/ 2>/dev/null; then
  echo "⚠️  worker/ 有未提交改动。建议先跑一次集成测试："
  echo "      bash scripts/test-integration.sh"
  echo "   （它会自己起本地 Worker + D1，跑 108 项后端与后台表单断言）"
  echo ""
fi

# ── 8. 迁移检查（wrangler deploy 不会自动应用迁移，这是最容易漏的一步）─────────
# wrangler.toml 里没有 migrations_dir，`npx wrangler deploy` 只部署代码、
# 不碰 D1 的表结构。于是"代码引用了新表/新列，但线上表还没建"会让接口运行时
# 报错 —— 0005_site_history 就是手工 `d1 execute --remote` 应用的。
# 这里把 *_up.sql 列出来提醒，绝不自动应用（_down 文件和重复的 0001_init.sql
# 混在目录里，自动应用会出事故；且 --remote 会动生产数据，必须人工确认）。
echo "8️⃣  迁移检查（如有 *_up.sql 未应用，必须先手工执行，再部署）..."
UP_FILES=$(ls "$PROJECT_DIR/worker/migrations/"*_up.sql 2>/dev/null)
if [ -n "$UP_FILES" ]; then
  echo "   迁移文件清单："
  echo "$UP_FILES" | sed 's#^#     - #'
  echo "   ⚠️  wrangler deploy 不会自动应用迁移。请确认这些 *_up.sql 已在远程 D1 应用："
  echo "      cd worker && npx wrangler d1 execute SKFREE_DB --remote --file migrations/XXXX_up.sql"
  echo "   （幂等的 IF NOT EXISTS 可重复执行；含 ALTER/非幂等语句的只能执行一次）"
else
  echo "   （没有迁移文件）"
fi
echo ""

# ── 9. 部署 ───────────────────────────────────────────────────────────────────
echo "📦 开始部署..."
cd "$PROJECT_DIR/worker"
npx wrangler deploy

echo ""
echo "✅ 部署完成"
echo ""

# ── 10. 部署后自动验证 ─────────────────────────────────────────────────────────
# 使用前端产物的内容哈希验证线上版本
echo "🔍 部署后自动验证..."
SYNC_OUTPUT=$(node "$SCRIPT_DIR/sync-frontend-assets.mjs" 2>&1)
echo "$SYNC_OUTPUT"
BUILD_HASH=$(echo "$SYNC_OUTPUT" | grep -oE 'build:[a-f0-9]+' | head -1 | sed 's/build://')
if [ -z "$BUILD_HASH" ]; then
  echo "🚫 未能从 sync-frontend-assets.mjs 捕获 BUILD_HASH"
  exit 1
fi
echo "📋 构建标识: build:${BUILD_HASH}"
bash "$SCRIPT_DIR/verify-deploy.sh" "$BUILD_HASH"
