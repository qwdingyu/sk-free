#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# deploy.sh — sk-free 本地一键部署脚本
#
# 职责：
#   1. 校验数据文件 sites.json 的合法性
#   2. 提交并推送到 GitHub（触发 GitHub Pages 自动部署）
#   3. 可选：部署投票 Worker 到 Cloudflare
#
# 前提：
#   - gh CLI 已登录（gh auth status）
#   - git remote deploy 指向目标仓库（qwdingyu/sk-free）
#   - 可选：npx wrangler login（如需部署投票 Worker）
#
# 用法：
#   bash deploy.sh           # 仅推送到 GitHub Pages
#   bash deploy.sh --worker  # 同时部署投票 Worker
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"

# ── 颜色 ──────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[deploy]${NC} $*"; }
warn()  { echo -e "${YELLOW}[deploy]${NC} $*"; }
err()   { echo -e "${RED}[deploy]${NC} $*" >&2; }

cd "$ROOT"

DEPLOY_WORKER=false
for arg in "$@"; do
  case "$arg" in
    --worker) DEPLOY_WORKER=true ;;
  esac
done

# ═══════════════════════════════════════════════════════════════════════════════
# 步骤 1：校验数据文件
# ═══════════════════════════════════════════════════════════════════════════════
DATA_FILE="$ROOT/broadcast/data/sites.json"
if [ ! -f "$DATA_FILE" ]; then
  err "数据文件不存在：$DATA_FILE"
  exit 1
fi

info "步骤 1/4：校验 sites.json..."

# JSON 语法校验（node 或 python 二选一）
if command -v node &>/dev/null; then
  JSON_VALID=$(node -e "
    try {
      const data = JSON.parse(require('fs').readFileSync('$DATA_FILE', 'utf8'));
      const sites = data.sites || [];
      const issues = [];

      // 校验 metadata
      if (!data.metadata) issues.push('缺少 metadata 字段');
      if (!data.metadata?.updatedAt) issues.push('metadata 缺少 updatedAt');

      // 逐条校验站点
      sites.forEach((s, i) => {
        if (!s.name) issues.push('第' + (i+1) + '条：缺少 name');
        if (!s.url) issues.push('第' + (i+1) + '条：缺少 url');
        if (s.url && !s.url.startsWith('http')) issues.push('第' + (i+1) + '条：url 格式错误');
        if (!s.tags || !Array.isArray(s.tags)) issues.push('第' + (i+1) + '条：tags 应为数组');
        if (!s.summary) issues.push('第' + (i+1) + '条：缺少 summary');
      });

      if (issues.length) {
        console.log('WARN: 发现 ' + issues.length + ' 个问题：');
        issues.forEach(i => console.log('  - ' + i));
        process.exit(1);
      }
      console.log('OK: ' + sites.length + ' 个站点，格式正确');
      process.exit(0);
    } catch(e) {
      console.log('ERROR: JSON 解析失败: ' + e.message);
      process.exit(2);
    }
  " 2>&1) || true

  echo "$JSON_VALID"
  if echo "$JSON_VALID" | grep -q "^ERROR"; then
    err "数据文件校验失败，中止部署"
    exit 1
  fi
elif command -v python3 &>/dev/null; then
  python3 -c "
import json, sys
try:
    with open('$DATA_FILE') as f: data = json.load(f)
    sites = data.get('sites', [])
    for i, s in enumerate(sites):
        if not s.get('name'): print(f'WARN: 第{i+1}条缺少 name')
        if not s.get('url'): print(f'WARN: 第{i+1}条缺少 url')
    print(f'OK: {len(sites)} 个站点')
except Exception as e:
    print(f'ERROR: {e}', file=sys.stderr); sys.exit(1)
  " || { err "数据校验失败"; exit 1; }
else
  warn "跳过 JSON 校验（无 node/python3）"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# 步骤 2：校验 CNAME 文件
# ═══════════════════════════════════════════════════════════════════════════════
info "步骤 2/4：校验 CNAME..."
CNAME_FILE="$ROOT/CNAME"
if [ ! -f "$CNAME_FILE" ]; then
  err "缺少 CNAME 文件，GitHub Pages 自定义域名将失效"
  exit 1
fi
DOMAIN=$(cat "$CNAME_FILE" | tr -d '[:space:]')
if [ -z "$DOMAIN" ]; then
  err "CNAME 文件为空"
  exit 1
fi
info "  域名：$DOMAIN"

# ═══════════════════════════════════════════════════════════════════════════════
# 步骤 3：Git 提交 & 推送
# ═══════════════════════════════════════════════════════════════════════════════
info "步骤 3/4：Git 操作..."

# 检查是否有变更
if git diff --quiet && git diff --staged --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
  info "  工作区干净，无变更需要提交"
else
  # 显示变更概览
  echo ""
  git status --short
  echo ""

  # 交互式确认
  read -p "是否提交以上变更？(y/N) " -n 1 -r
  echo ""
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    git add -A
    # 生成提交信息：基于变更文件自动生成
    CHANGED_FILES=$(git diff --staged --name-only)
    if echo "$CHANGED_FILES" | grep -q "sites.json"; then
      SITE_COUNT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$DATA_FILE','utf8')).sites.length)" 2>/dev/null || echo "?")
      COMMIT_MSG="Update broadcast: ${SITE_COUNT} sites $(date +%Y-%m-%d)"
    else
      COMMIT_MSG="Update broadcast $(date +%Y-%m-%d)"
    fi

    git commit -m "$COMMIT_MSG"
    info "  已提交：$COMMIT_MSG"
  else
    info "  跳过提交"
  fi
fi

# 推送到 deploy remote
DEPLOY_REMOTE=$(git remote | grep deploy || true)
if [ -n "$DEPLOY_REMOTE" ]; then
  info "  推送到 deploy (qwdingyu/sk-free)..."
  git push deploy main
  info "  推送成功！GitHub Actions 正在部署..."
else
  warn "  未找到 deploy remote，请手动推送"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# 步骤 4：部署投票 Worker（可选）
# ═══════════════════════════════════════════════════════════════════════════════
if [ "$DEPLOY_WORKER" = true ]; then
  info "步骤 4/4：部署投票 Worker..."

  WORKER_DIR="$ROOT/worker"
  if [ ! -d "$WORKER_DIR" ]; then
    err "  Worker 目录不存在：$WORKER_DIR"
    exit 1
  fi

  # 检查 wrangler 登录状态
  if ! npx wrangler whoami &>/dev/null 2>&1; then
    err "  请先执行 npx wrangler login 登录 Cloudflare"
    exit 1
  fi

  cd "$WORKER_DIR"

  # ── 4a. KV 命名空间初始化 ──
  if grep -q "<YOUR_KV_NAMESPACE_ID>" wrangler.toml; then
    warn "  KV 命名空间 ID 未配置，正在创建..."
    KV_OUTPUT=$(npx wrangler kv:namespace create SKFREE_KV 2>&1)
    echo "$KV_OUTPUT"

    # 从输出中提取 ID
    KV_ID=$(echo "$KV_OUTPUT" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
    if [ -n "$KV_ID" ]; then
      sed -i.bak "s/<YOUR_KV_NAMESPACE_ID>/$KV_ID/" wrangler.toml
      rm -f wrangler.toml.bak
      info "  KV 命名空间已创建：$KV_ID"
    else
      err "  无法解析 KV ID，请手动配置 wrangler.toml"
      exit 1
    fi
  fi

  # ── 4b. ADMIN_TOKEN secret 初始化 ──
  # 检查 ADMIN_TOKEN 是否已设置（通过 wrangler secret list 查询）
  SECRETS_LIST=$(npx wrangler secret list 2>&1 || true)
  if ! echo "$SECRETS_LIST" | grep -q "ADMIN_TOKEN"; then
    warn "  ADMIN_TOKEN 未设置，需要配置管理密码"
    echo ""
    echo "  请设置管理密码（用于访问 /admin 管理页面）："
    echo "  执行：cd worker && npx wrangler secret put ADMIN_TOKEN"
    echo "  然后输入一个强密码"
    echo ""
    read -p "  是否现在设置？(y/N) " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
      npx wrangler secret put ADMIN_TOKEN
      info "  ADMIN_TOKEN 已设置"
    else
      warn "  跳过 ADMIN_TOKEN 设置（管理页面将无法登录）"
    fi
  else
    info "  ADMIN_TOKEN 已配置"
  fi

  # ── 4c. 部署 Worker ──
  npx wrangler deploy
  info "  Worker 部署完成"

  # 显示管理页面地址
  WORKER_NAME=$(grep '^name' wrangler.toml | head -1 | cut -d'"' -f2)
  echo ""
  info "  📋 管理页面：https://${WORKER_NAME}.workers.dev/admin"
  cd "$ROOT"
else
  info "步骤 4/4：跳过 Worker 部署（使用 --worker 参数启用）"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# 完成
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
info "═══════════════════════════════════════════════════"
info "  部署流程完成！"
info "  前端地址：https://$DOMAIN/broadcast/"
info "  GitHub Actions 部署通常需要 1-2 分钟"
info "═══════════════════════════════════════════════════"
echo ""
info "查看部署状态：gh run list --repo qwdingyu/sk-free --limit 3"
