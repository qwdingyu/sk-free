#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# deploy.sh — 安全部署脚本（含预检查）
#
# 使用方式：bash scripts/deploy.sh
# 替代直接运行：npx wrangler deploy
#
# 预检查任何一步失败都会阻止部署（set -e）。
# 检查顺序按"越便宜越靠前"排列，快速失败。
# ═══════════════════════════════════════════════════════════════════════════════

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "🔍 部署前检查..."
echo ""

# ── 1. 语法检查（最便宜，先跑）─────────────────────────────────────────────────
echo "1️⃣  语法检查..."
for f in "$PROJECT_DIR"/worker/index.js "$PROJECT_DIR"/worker/src/*.js "$PROJECT_DIR"/broadcast/src/*.js; do
  node --check "$f" || { echo "🚫 语法错误：$f"; exit 1; }
done
echo "✅ 所有 JS 文件语法通过"
echo ""

# ── 2. 前后端字段契约检查 ──────────────────────────────────────────────────────
# 前端读 site.quota_tier 而后端产出 quotaTier 这类问题不会抛错，
# 只会让页面静默显示"未知"。必须机器校验。
echo "2️⃣  前后端字段契约检查..."
node "$SCRIPT_DIR/check-api-contract.js"
echo ""

# ── 3. CSS 覆盖检查 ────────────────────────────────────────────────────────────
# JS createElement 出的 class 如果没有对应 CSS 规则，元素会以无定位的
# 普通块渲染（抽屉就这样飘到了页脚下方），JS 和 CSS 都不会报错。
echo "3️⃣  CSS 覆盖检查..."
node "$SCRIPT_DIR/check-css-coverage.js"
echo ""

# ── 4. 从 broadcast/ 源文件构建产物（消灭手工双副本）──────────────────────────
# 捕获 BUILD_TS（build-html.js 输出），供第 8 步部署后验证使用
echo "4️⃣  构建 broadcast-html.js + 开发 bundle..."
BUILD_OUTPUT=$(node "$SCRIPT_DIR/build-html.js")
BUILD_TS=$(echo "$BUILD_OUTPUT" | sed -n 's/.*BUILD_TS=\([^ ]*\).*/\1/p')
if [ -z "$BUILD_TS" ]; then
  echo "🚫 未能从构建输出捕获 BUILD_TS，中止部署"
  exit 1
fi
echo ""

# ── 5. 前端行为回归测试（需要 jsdom，没装则自动跳过）──────────────────────────
# 拦的是"页面照样渲染、功能静默失效"那一类：字段错配、面板自己关掉、
# 死链分组不可达、监听器泄漏、时区偏差。
echo "5️⃣  前端行为回归测试..."
node "$SCRIPT_DIR/test-frontend.mjs"
echo ""

# ── 6. 模板字面量转义安全检查（两个内联 HTML 的文件都要查）─────────────────────
echo "6️⃣  模板字面量转义检查..."
node "$SCRIPT_DIR/check-template-escapes.js" "$PROJECT_DIR/worker/index.js"
node "$SCRIPT_DIR/check-template-escapes.js" "$PROJECT_DIR/worker/broadcast-html.js"
echo ""

# ── 7. 部署 ───────────────────────────────────────────────────────────────────
echo "📦 开始部署..."
cd "$PROJECT_DIR/worker"
npx wrangler deploy

echo ""
echo "✅ 部署完成"
echo ""

# ── 8. 部署后自动验证 ──────────────────────────────────────────────────────────
# 不能只靠"部署命令成功"——上一次就是部署成功但线上跑的是旧 bundle（抽屉
# 样式缺失、无定位 div），链路本身不报错。必须用构建标识对线上做断言。
# 验证失败以非零退出，提醒人工检查（wrangler rollback 可回滚）。
echo "8️⃣  部署后自动验证..."
bash "$SCRIPT_DIR/verify-deploy.sh" "$BUILD_TS"
