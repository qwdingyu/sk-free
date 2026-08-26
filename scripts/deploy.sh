#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# deploy.sh — 安全部署脚本（含预检查）
#
# 使用方式：bash scripts/deploy.sh
# 替代直接运行：npx wrangler deploy
#
# 预检查任何一步失败都会阻止部署（set -e）。共 9 步：6 步预检查 + 提醒 + 部署 + 部署后验证。
# 检查顺序按"越便宜越靠前"排列，快速失败。
#
# pipefail 是必需的：第 4 步用 `node build-html.js | tee` 同时保留输出和取
# BUILD_ID，没有 pipefail 时管道的退出码是 tee 的（永远 0），构建失败会被
# 一路带到 wrangler deploy —— 正好是这个脚本要防的事。
# ═══════════════════════════════════════════════════════════════════════════════

set -e
set -o pipefail

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
# 捕获 BUILD_ID（build-html.js 输出的内容哈希），供第 8 步部署后验证使用。
# 用 tee 而不是纯命令替换：build-html.js 会打印转义往返验证、内联脚本语法
# 检查的结果，这些是部署前最关键的几行，不能因为要取一个变量就把它们吞掉。
echo "4️⃣  构建 broadcast-html.js + 开发 bundle..."
BUILD_LOG=$(mktemp)
node "$SCRIPT_DIR/build-html.js" | tee "$BUILD_LOG"
BUILD_ID=$(sed -n 's/.*BUILD_ID=\([^ ]*\).*/\1/p' "$BUILD_LOG")
rm -f "$BUILD_LOG"
if [ -z "$BUILD_ID" ]; then
  echo "🚫 未能从构建输出捕获 BUILD_ID，中止部署"
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
# 不能只靠"部署命令成功"——上一次就是部署成功但线上跑的是旧 bundle（抽屉
# 样式缺失、无定位 div），链路本身不报错。必须用构建标识对线上做断言。
# 验证失败以非零退出，提醒人工检查（wrangler rollback 可回滚）。
echo "8️⃣  部署后自动验证..."
bash "$SCRIPT_DIR/verify-deploy.sh" "$BUILD_ID"
