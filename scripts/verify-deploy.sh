#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# verify-deploy.sh — 部署后自动验证
#
# 为什么需要它：
#   "部署命令成功返回" 不等于 "线上跑的是刚构建的产物"。wrangler 可能因为
#   构建缓存 skip、可能部署到了别的 environment、也可能中途有别的会话改了源码。
#   这些情况链路本身都不报错，只有用构建标识对线上做断言才能兜住。
#
# 断言的写法有个坑（真踩过）：
#   起初这里断言线上包含 ".drawer-overlay" 来证明抽屉样式在，但内联的 JS 里
#   本来就有 document.querySelector(".drawer-overlay")，所以 CSS 规则一个都
#   没有时这条断言照样 [OK]。实测：拿 dc41628（抽屉 CSS 完全缺失）的 styles.css
#   构建产物，这条断言仍然通过。
#   → 断言必须挑"只有目标产物才可能包含"的字符串。这里改用 CSS 专有的
#     复合选择器 `.drawer-overlay.open`（JS 从不写这个组合）。
#
#   顺带纠正一条错误归因：抽屉缺样式不是"线上跑旧 bundle"，而是那段 CSS
#   从来没被写过（git log -S".drawer-overlay" -- broadcast/styles.css
#   只有 621a738 一条，即补上它的那次提交）。两回事，别混。
#
# 用法：bash scripts/verify-deploy.sh <BUILD_ID> [URL]
# 退出码：0 = 线上就是刚构建的产物；1 = 线上与构建不一致（考虑回滚）
#
# 注意：不得在双引号字符串里让 $VAR 与全角标点紧贴（如 "$URL，"）——
# 本机 bash 会把全角字符的第一个字节并入变量名，set -u 下报
# "URL: unbound variable"。一律写 ${VAR} 花括号形式，或与中文间留空格。
# ═══════════════════════════════════════════════════════════════════════════════

set -u

BUILD_ID="${1:-}"
URL="${2:-https://free.eforge.xyz/}"

if [ -z "$BUILD_ID" ]; then
  echo "🚫 verify-deploy.sh: 缺少 BUILD_ID 参数 (从 build-html.js 输出捕获内容哈希)"
  exit 1
fi

echo "🔎 部署后验证: URL=${URL} BUILD_ID=${BUILD_ID} ..."

# 边缘节点传播可能有几秒延迟。只对"构建标识"（内容哈希）做有限重试——
# 如果这里不重试，一次传播延迟就会打印"考虑回滚"，而回滚一个其实正常的
# 部署，风险比多等 12 秒大得多。
HTML=""
for attempt in 1 2 3 4; do
  HTML=$(curl -s --max-time 20 -H "Cache-Control: no-cache" "$URL" || true)
  if echo "$HTML" | grep -qF "build:${BUILD_ID}"; then
    [ "$attempt" -gt 1 ] && echo "  (第 ${attempt} 次拉取命中，边缘传播延迟属正常)"
    break
  fi
  if [ "$attempt" -lt 4 ]; then
    echo "  ... 第 ${attempt} 次未见新构建标识，等 4 秒重试"
    sleep 4
  fi
done

API=$(curl -s --max-time 20 "${URL}api/sites" || true)

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

assert_html "线上内容哈希与本地构建一致" "build:${BUILD_ID}"
# 下面这些断言只挑 CSS 专有形态：`.drawer-overlay` 裸写会被内联 JS 里的
# querySelector(".drawer-overlay") 满足，等于没查。
assert_html "抽屉遮罩样式 (.drawer-overlay.open)" ".drawer-overlay.open"
assert_html "抽屉基础定位 (position: fixed)" ".drawer-overlay {"
assert_html "抽屉关闭按钮样式 (.drawer-close)" ".drawer-close {"
assert_html "抽屉标题样式 (.drawer-title)" ".drawer-title {"
assert_html "hero 标题行 (hero-title-row)" "hero-title-row"
assert_html "统计条存在 (summary-strip)" "summary-strip"
assert_html "反馈弹窗存在 (feedbackModal)" "feedbackModal"
# 死链分组的展开入口（曾因 matchesFilters 过滤死链而整套不可达）
assert_html "死链分组样式 (.dead-group)" ".dead-group {"

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