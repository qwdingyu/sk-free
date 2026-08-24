#!/bin/bash
# InfoHub 平台部署脚本
# 用法: bash scripts/deploy.sh
#
# 部署 Worker 到 Cloudflare Workers

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKER_DIR="$(dirname "$SCRIPT_DIR")/worker"

echo "🚀 部署 Worker..."

if [[ ! -d "$WORKER_DIR" ]]; then
  echo "❌ Worker 目录不存在: $WORKER_DIR"
  exit 1
fi

cd "$WORKER_DIR"

# 检查 wrangler 是否安装
if ! command -v npx &> /dev/null; then
  echo "❌ 请先安装 Node.js 和 npm"
  exit 1
fi

echo "📦 构建并部署..."
npx wrangler deploy

echo ""
echo "✅ 部署完成！"
echo ""
echo "下一步:"
echo "  1. 访问 /admin 进入管理后台"
echo "  2. 登录后通过 Schema 标签页配置平台"
echo "  3. 通过站点管理标签页导入数据"
