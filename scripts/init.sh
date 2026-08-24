#!/bin/bash
# InfoHub 平台初始化脚本
# 用法: bash scripts/init.sh <project-name> [--template <template-name>]
#
# 示例:
#   bash scripts/init.sh my-nav --template directory
#   bash scripts/init.sh feedback-site --template feedback

set -e

PROJECT_NAME="${1:-my-infohub}"
TEMPLATE="${2:-directory}"

# 解析 --template 参数
if [[ "$1" == "--template" ]]; then
  TEMPLATE="$2"
  PROJECT_NAME="${3:-my-infohub}"
fi
if [[ "$2" == "--template" ]]; then
  TEMPLATE="$3"
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")/projects/$PROJECT_NAME"
TEMPLATE_DIR="$(dirname "$SCRIPT_DIR")/templates/$TEMPLATE"

echo "🚀 初始化项目: $PROJECT_NAME"
echo "📦 模板: $TEMPLATE"
echo ""

# 检查模板是否存在
if [[ ! -d "$TEMPLATE_DIR" ]]; then
  echo "❌ 模板 '$TEMPLATE' 不存在"
  echo "可用模板: directory, collection, feedback, roster, catalog"
  exit 1
fi

# 创建项目目录
mkdir -p "$PROJECT_DIR"
cp "$TEMPLATE_DIR/schema.json" "$PROJECT_DIR/schema.json"

echo "✅ 项目已创建: $PROJECT_DIR"
echo ""
echo "下一步:"
echo "  1. 编辑 $PROJECT_DIR/schema.json 自定义字段"
echo "  2. 部署 Worker: cd worker && npx wrangler deploy"
echo "  3. 通过 Admin 后台导入 Schema"
echo "  4. 导入初始数据"
