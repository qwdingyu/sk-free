#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# test-integration.sh — 起一个本地 Worker + 本地 D1，跑后端与管理后台的集成测试
#
# 为什么单独拿出来、不塞进 deploy.sh：
#   它要真起一个 wrangler dev（约 15 秒）并建本地数据库，塞进部署脚本会让每次
#   部署都慢一截，而且多一层可能卡住的依赖。
#   但它拦的是**只有打真实接口才能发现**的那一类 bug（合并语义看错 → 静默数据
#   丢失、表单加了框但没发出去），所以改动 worker/ 之后应该手动跑一次。
#
#   注意：绝不做成"没起服务就跳过并打勾"。空检查报通过比没有检查更危险 ——
#   这个脚本自己负责把服务起起来，起不来就红。
#
# 用法：bash scripts/test-integration.sh
# 退出码：0 = 全绿；非 0 = 有断言失败或环境没就绪
# ═══════════════════════════════════════════════════════════════════════════════

set -u
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
WORKER_DIR="$PROJECT_DIR/worker"
PORT="${PORT:-8799}"
BASE="http://127.0.0.1:${PORT}"
TOKEN="localtest123"
WDEV_LOG="$(mktemp)"
WDEV_PID=""

cleanup() {
  if [ -n "$WDEV_PID" ] && kill -0 "$WDEV_PID" 2>/dev/null; then
    kill "$WDEV_PID" 2>/dev/null || true
    wait "$WDEV_PID" 2>/dev/null || true
  fi
  # 清掉本次跑脏的所有表。**rate_limits 必须一起清**：
  # 投票限流是 (site_name, ip) 每小时 10 次，窗口 1 小时内的行不会被自动清理。
  # 只删 sites/votes 的话，rate_limits 里的旧行会跨多次运行累积，
  # 跑到第 10 次以后 /api/vote 就开始 429，测试变成偶发失败 —— 实测复现过：
  # 连跑两次都是"投 up 期望 200 实际 429"。
  (cd "$WORKER_DIR" && npx wrangler d1 execute SKFREE_DB --local \
     --command "DELETE FROM sites; DELETE FROM votes; DELETE FROM feedbacks; DELETE FROM submissions; DELETE FROM rate_limits; DELETE FROM dead_urls;" \
     >/dev/null 2>&1) || true
  rm -f "$WDEV_LOG"
}
trap cleanup EXIT

echo "🧪 集成测试：起本地 Worker + 本地 D1"
echo ""

# ── 1. 依赖 ───────────────────────────────────────────────────────────────────
if [ ! -x "$WORKER_DIR/node_modules/.bin/wrangler" ]; then
  echo "1️⃣  安装 worker 依赖（wrangler）..."
  (cd "$WORKER_DIR" && npm install --no-audit --no-fund --silent) || {
    echo "🚫 npm install 失败，无法起本地 Worker"; exit 1; }
else
  echo "1️⃣  wrangler 已就绪"
fi

# ── 2. 本地 secret ────────────────────────────────────────────────────────────
# .dev.vars 已在 .gitignore 里（.dev.vars*），只用于本地
printf 'ADMIN_TOKEN=%s\n' "$TOKEN" > "$WORKER_DIR/.dev.vars"
echo "2️⃣  已写入本地 .dev.vars"

# ── 3. 本地 D1 迁移 ───────────────────────────────────────────────────────────
echo "3️⃣  应用迁移到本地 D1..."
# 动态应用所有 *_up.sql，而不是写死 0001-0004：
# 上次这里漏了 0005_site_history，而 worker/src/sites.js 已经引用 site_history，
# 靠"本地 D1 早就被手动建过表"才没翻车 —— 换个干净环境跑就是 500。
# 写死清单必会再漏下一个 0006，按文件名排序全部应用才对。
MIGRATIONS=$(ls "$WORKER_DIR/migrations/"*_up.sql 2>/dev/null | sort)
if [ -z "$MIGRATIONS" ]; then
  echo "🚫 没有找到任何 *_up.sql 迁移文件"
  exit 1
fi
for m in $MIGRATIONS; do
  (cd "$WORKER_DIR" && npx wrangler d1 execute SKFREE_DB --local --file "$m" >/dev/null 2>&1) || true
done
TABLES=$(cd "$WORKER_DIR" && npx wrangler d1 execute SKFREE_DB --local \
  --command "SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name IN ('sites','votes','feedbacks','submissions','dead_urls','rate_limits','site_history')" 2>&1 \
  | grep -o '"n": *[0-9]*' | grep -o '[0-9]*' | head -1)
if [ "${TABLES:-0}" -lt 7 ]; then
  echo "🚫 本地 D1 建表不完整（只找到 ${TABLES:-0}/7 张表），迁移可能失败"
  exit 1
fi
echo "    ✅ 7 张表就绪"

# 开跑前先清一次：上一次异常退出（Ctrl-C、超时）可能留下脏状态，
# 尤其是 rate_limits 里没过期的行会让投票断言直接 429。
(cd "$WORKER_DIR" && npx wrangler d1 execute SKFREE_DB --local \
   --command "DELETE FROM sites; DELETE FROM votes; DELETE FROM feedbacks; DELETE FROM submissions; DELETE FROM rate_limits; DELETE FROM dead_urls;" \
   >/dev/null 2>&1) || true
echo "    ✅ 已重置本地测试数据（含 rate_limits）"

# ── 4. 起 wrangler dev ────────────────────────────────────────────────────────
echo "4️⃣  启动 wrangler dev (:${PORT})..."
(cd "$WORKER_DIR" && npx wrangler dev --local --port "$PORT" --test-scheduled > "$WDEV_LOG" 2>&1) &
WDEV_PID=$!
READY=""
for _ in $(seq 1 40); do
  sleep 1
  if curl -s -m 2 "${BASE}/api/sites" | grep -q '"ok"'; then READY=1; break; fi
  if ! kill -0 "$WDEV_PID" 2>/dev/null; then break; fi
done
if [ -z "$READY" ]; then
  echo "🚫 wrangler dev 未能就绪，日志尾部："
  tail -20 "$WDEV_LOG"
  exit 1
fi
echo "    ✅ 服务就绪"
echo ""

# ── 5. 后端 HTTP 集成测试 ─────────────────────────────────────────────────────
echo "5️⃣  后端 API 集成测试..."
node "$SCRIPT_DIR/test-api.mjs" "$BASE" "$TOKEN" || exit 1
echo ""

# ── 6. 管理后台表单行为测试 ───────────────────────────────────────────────────
echo "6️⃣  管理后台表单行为测试..."
node "$SCRIPT_DIR/test-admin-form.mjs" "$BASE" "$TOKEN" || exit 1
echo ""

# ── 7. 定时健康检查 ───────────────────────────────────────────────────────────
# 只验最关键的两条不变量：活站写 verified_at、失败站绝不被自动禁用。
echo "7️⃣  定时健康检查（cron）..."
# 建两个站。创建失败必须立刻红 —— 否则后面的断言会因为"行不存在"而
# 全部变成 undefined，其中"死站不写 verified_at"还会假通过（isNull(undefined)
# 也是真）。空断言报通过比没有断言更危险。
for pair in "cron活站|https://example.com" "cron死站|https://no-such-host-9x8y7z.invalid"; do
  n="${pair%%|*}"; u="${pair##*|}"
  RESP=$(curl -s -X POST "${BASE}/api/admin/sites" -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" -d "{\"name\":\"${n}\",\"url\":\"${u}\",\"tags\":[]}")
  if ! printf '%s' "$RESP" | grep -q '"ok":true'; then
    echo "    ❌ 建站 ${n} 失败，后续 cron 断言无意义：${RESP}"
    exit 1
  fi
done
curl -s -m 90 "${BASE}/__scheduled?cron=0+*/6+*+*+*" >/dev/null
sleep 3
CRON_JSON=$(cd "$WORKER_DIR" && npx wrangler d1 execute SKFREE_DB --local \
  --command "SELECT name, verified_at, verified_by, health_fail_count, enabled FROM sites WHERE name LIKE 'cron%'" 2>&1)
node -e '
const t = process.argv[1];
const m = t.match(/\[\s*\{[\s\S]*\}\s*\]/);
const rows = m ? JSON.parse(m[0])[0].results : [];
const by = (n) => rows.find((r) => r.name === n) || {};
// wrangler 3.x 的 `d1 execute` CLI 输出会把 SQL NULL 渲染成字符串 "null"
// （实测 {"verified_at":"null"}，typeof 是 string）。这是 CLI 的展示问题，
// 不是代码问题 —— 真实的 D1 binding 返回的是 JSON null，/api/sites 里
// verifiedAt 就是 null。所以这里两种都当成"空"，别去改 worker 的代码。
const isNull = (v) => v === null || v === undefined || v === "null";
let bad = 0;
const chk = (name, ok, detail) => { console.log(`    ${ok ? "✅" : "❌"} ${name}${ok ? "" : "  → " + detail}`); if (!ok) bad++; };
const alive = by("cron活站"), dead = by("cron死站");
chk("两个测试站都查到了（否则后面全是空断言）", rows.length === 2 && alive.name && dead.name, `rows=${rows.length}`);
chk("活站写入 verified_at", !isNull(alive.verified_at), `verified_at=${alive.verified_at}`);
chk("活站 verified_by=healthcheck", alive.verified_by === "healthcheck", `verified_by=${alive.verified_by}`);
chk("死站累加 health_fail_count", dead.health_fail_count >= 1, `fail=${dead.health_fail_count}`);
chk("死站不写 verified_at（不伪造鲜度）", isNull(dead.verified_at), `verified_at=${dead.verified_at}`);
chk("失败站绝不被自动禁用", dead.enabled === 1, `enabled=${dead.enabled}`);
process.exit(bad ? 1 : 0);
' "$CRON_JSON" || exit 1
echo ""

echo "────────────────────────────────────────────────────────────"
echo "✅ 集成测试全部通过"
