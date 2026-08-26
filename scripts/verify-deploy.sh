#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# verify-deploy.sh — 部署后自动验证
#
# 为什么需要它（血泪教训）：
#   "部署完成" 不等于 "新代码在跑"。上一次抽屉缺样式：部署命令成功返回、
#   服务端点 200、用户打开页面——但线上是旧 bundle，抽屉 CSS 缺失，点击
#   「⋯」弹窗飘到页脚下方。没有任何人察觉，直到用户肉眼发现。
#   部署动作本身不报错，只有"用构建标识对线上做断言"才能兜住。
#
# 用法：bash scripts/verify-deploy.sh <BUILD_TS> [URL]
# 退出码：0 = 线上就是刚构建的产物；1 = 线上与构建不一致（考虑回滚）
#
# 注意：不得在双引号字符串里让 $VAR 与全角标点紧贴（如 "$URL，"）——
# 本机 bash 会把全角字符的第一个字节并入变量名，set -u 下报
# "URL: unbound variable"。一律写 ${VAR} 花括号形式，或与中文间留空格。
# ═══════════════════════════════════════════════════════════════════════════════

set -u

BUILD_TS="${1:-}"
URL="${2:-https://free.eforge.xyz/}"

if [ -z "$BUILD_TS" ]; then
  echo "🚫 verify-deploy.sh: 缺少 BUILD_TS 参数 (从 build-html.js 输出捕获)"
  exit 1
fi

echo "🔎 部署后验证: URL=${URL} BUILD_TS=${BUILD_TS} ..."

HTML=$(curl -s --max-time 20 "$URL")
API=$(curl -s --max-time 20 "${URL}api/sites")

fail=0

assert_html() {
  local name="$1"
  local pattern="$2"
  # -F：构建时间戳含 '.'，作为正则元字符会宽松匹配，必须按固定字符串比较
  if echo "$HTML" | grep -qF "$pattern"; then
    echo "  [OK] ${name}"
  else
    echo "  [FAIL] ${name} —— 线上页面未找到 '${pattern}' (线上可能不是刚部署的版本)"
    fail=1
  fi
}

assert_html "构建时间戳与本地一致" "build:${BUILD_TS}"
assert_html "抽屉基础样式 (.drawer-overlay)" ".drawer-overlay"
assert_html "抽屉关闭按钮 (.drawer-close)" ".drawer-close"
assert_html "hero 标题行 (hero-title-row)" "hero-title-row"
assert_html "统计条存在 (summary-strip)" "summary-strip"
assert_html "反馈弹窗存在 (feedbackModal)" "feedbackModal"

if echo "$API" | grep -q '"ok":true'; then
  echo "  [OK] /api/sites 正常返回"
else
  echo "  [FAIL] /api/sites 异常 (返回内容开头: $(echo "$API" | head -c 120))"
  fail=1
fi

if echo "$API" | grep -q 'quotaTier'; then
  echo "  [OK] 额度字段 quotaTier 存在 (不会整列'额度未知')"
else
  echo "  [FAIL] 额度字段缺失——前端读的字段与 API 产出不一致"
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo "✅ 部署验证全部通过: 线上跑的就是刚构建的这份产物"
  exit 0
fi

echo ""
echo "🚫 部署验证失败: 线上内容与本地构建不一致"
echo "   回滚命令: cd worker && npx wrangler rollback"
echo "   排查方向: 确认 wrangler deploy 输出里没有 skipped;"
echo "            确认没有别的进程/会话在部署途中改动了源码"
exit 1