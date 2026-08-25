#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# deploy.sh — 安全部署脚本（含预检查）
#
# 使用方式：bash scripts/deploy.sh
# 替代直接运行：npx wrangler deploy
#
# 部署前会自动执行模板字面量转义检查，发现问题则阻止部署。
# ═══════════════════════════════════════════════════════════════════════════════

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "🔍 部署前检查..."
echo ""

# 检查模板字面量转义安全（两个文件都要检查）
node "$SCRIPT_DIR/check-template-escapes.js" "$PROJECT_DIR/worker/index.js"
CHECK_EXIT=$?

node "$SCRIPT_DIR/check-template-escapes.js" "$PROJECT_DIR/worker/broadcast-html.js"
CHECK_EXIT2=$?

if [ $CHECK_EXIT -ne 0 ] || [ $CHECK_EXIT2 -ne 0 ]; then
  echo ""
  echo "🚫 部署被阻止：模板字面量转义检查未通过"
  echo "   请修复上述问题后重新运行此脚本"
  exit 1
fi

echo ""
echo "📦 开始部署..."
cd "$PROJECT_DIR/worker"
npx wrangler deploy

echo ""
echo "✅ 部署完成"
