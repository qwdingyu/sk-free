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

# ── 3. 从 broadcast/ 源文件构建产物（消灭手工双副本）──────────────────────────
echo "3️⃣  构建 broadcast-html.js + 开发 bundle..."
node "$SCRIPT_DIR/build-html.js"
echo ""

# ── 4. 模板字面量转义安全检查（两个内联 HTML 的文件都要查）─────────────────────
echo "4️⃣  模板字面量转义检查..."
node "$SCRIPT_DIR/check-template-escapes.js" "$PROJECT_DIR/worker/index.js"
node "$SCRIPT_DIR/check-template-escapes.js" "$PROJECT_DIR/worker/broadcast-html.js"
echo ""

# ── 5. 部署 ───────────────────────────────────────────────────────────────────
echo "📦 开始部署..."
cd "$PROJECT_DIR/worker"
npx wrangler deploy

echo ""
echo "✅ 部署完成"
echo ""
echo "👉 部署后请验证（这三条任一失败就要回滚）："
echo "   curl -s https://free.eforge.xyz/ | grep -c feedbackModal    # 反馈弹窗存在"
echo "   curl -s https://free.eforge.xyz/api/sites | head -c 200     # API 正常"
echo "   打开 https://free.eforge.xyz/ 确认额度列不是全部'额度未知'"
