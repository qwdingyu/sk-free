#!/usr/bin/env node
/**
 * test-frontend.mjs — 前端行为回归测试（jsdom）
 *
 * 为什么需要它：
 *   这个项目的前端没有框架、没有构建期类型检查，所有交互都是手写 DOM。
 *   最危险的不是语法错误（node --check 能拦），而是"页面照样渲染、
 *   功能静默失效"这一类问题。已经真实发生过三次：
 *     1. 前端读 snake_case 字段而 API 返回 camelCase → 18/18 显示"额度未知"
 *     2. 筛选项点一次就把"更多筛选"面板关掉 → 多选组没法多选
 *     3. matchesFilters 把死链过滤掉 → 死链分组的展开按钮永远不渲染，
 *        state.showDead 没有入口翻成 true，整套死链展示逻辑不可达
 *   这三个用眼睛看代码都不容易发现，跑一遍真实 DOM 立刻暴露。
 *
 * 用法：
 *   npm i jsdom            （在本目录或任意上层目录）
 *   node scripts/test-frontend.mjs
 *
 * 没装 jsdom 时会跳过并返回 0，不阻塞部署。
 */
import { readFileSync, readdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let JSDOM;
try {
  ({ JSDOM } = await import("jsdom"));
} catch {
  console.log("⏭️  未安装 jsdom，跳过前端行为测试（npm i jsdom 后可启用）");
  process.exit(0);
}

// ── 测试脚手架 ────────────────────────────────────────────────────────────────
let passed = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failures.push(`${name}\n       期望: ${JSON.stringify(expected)}\n       实际: ${JSON.stringify(actual)}`);
    console.log(`  ❌ ${name}  期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

/** 构造一份最小但字段齐全的站点数据（字段名必须与 formatSiteRow 一致） */
function makeSite(over = {}) {
  return {
    name: "站点", url: "https://example.com", originalUrl: "", ref: "",
    tags: [], summary: "", enabled: 1, checkin: "", models: "", rate: "",
    register: "", notes: [], sortOrder: 0, slug: "s1", kind: "api_site",
    quotaMin: null, quotaMax: null, quotaUnit: null, quotaPeriod: "none",
    quotaCallsEst: null, quotaTier: "none", quotaRaw: null, needsProxy: null,
    verifiedAt: null, verifiedBy: null, healthFailCount: 0,
    createdAt: "2026-08-01 00:00:00", updatedAt: "2026-08-01 00:00:00",
    dead: false, votes: { up: 0, down: 0 },
    ...over,
  };
}

const SITES = [
  makeSite({ name: "高额度站", slug: "s1", quotaMin: 25, quotaMax: 25, quotaUnit: "usd", quotaPeriod: "daily", quotaTier: "high" }),
  makeSite({ name: "中额度站", slug: "s2", quotaMin: 100, quotaMax: 100, quotaUnit: "credit", quotaPeriod: "daily", quotaCallsEst: 60, quotaTier: "mid" }),
  makeSite({ name: "未知额度站", slug: "s3", quotaRaw: "绑定账号即免费" }),
  makeSite({ name: "死链站A", slug: "s4", dead: true, quotaTier: "high", quotaMin: 9, quotaUnit: "usd", quotaPeriod: "daily" }),
  // 回归锚点：enabled 用后端真实形状（布尔 false）。99-boot 曾有
  // filter(s => s.enabled !== false) 把这行整条丢弃，「已失效 (2)」会变 (1)，
  // 下面的分组断言即失败——锁定"公开页不得裁剪后端全量数据"。
  makeSite({ name: "死链站B", slug: "s5", dead: true, enabled: false }),
];

async function boot(sites) {
  const html = readFileSync(join(ROOT, "frontend", "index.html"), "utf-8")
    .replace(/<script[^>]*src="[^"]*main\.js"[^>]*><\/script>/, "");
  
  // 拼接所有 broadcast 模块（按文件名排序），模拟旧的 build-html.js 产物
  const broadcastDir = join(ROOT, "frontend", "src", "broadcast");
  const modules = readdirSync(broadcastDir)
    .filter((f) => f.endsWith(".js"))
    .sort()
    .map((f) => readFileSync(join(broadcastDir, f), "utf-8"))
    .join("\n");

  const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://free.eforge.xyz/", pretendToBeVisual: true });
  const { window } = dom;

  // 追踪 document 上仍然注册着的 keydown 监听器。
  // 用 Set 而不是计数器：removeEventListener 对已移除的监听器是 no-op，
  // 计数器会把幂等移除也算一次，得出没有意义的负数。
  const liveKeydown = new Set();
  const oAdd = window.document.addEventListener.bind(window.document);
  const oRem = window.document.removeEventListener.bind(window.document);
  window.document.addEventListener = (t, f, o) => { if (t === "keydown") liveKeydown.add(f); return oAdd(t, f, o); };
  window.document.removeEventListener = (t, f, o) => { if (t === "keydown") liveKeydown.delete(f); return oRem(t, f, o); };

  window.fetch = async (u) => {
    const s = String(u);
    if (s.includes("/api/sites")) return { ok: true, json: async () => ({ ok: true, sites, metadata: { total: sites.length, enabled: sites.length, dead: sites.filter((x) => x.dead).length } }) };
    return { ok: true, json: async () => ({ ok: true, notice: null }) };
  };
  window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  window.eval(modules);
  // 启动应用（init 是 async 的，需要等待数据加载完成）
  if (typeof window.init === "function") {
    await window.init();
  }
  await new Promise((r) => setTimeout(r, 100));
  return { window, doc: window.document, liveKeydown };
}

const click = (win, el) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

// ══ 1. 结构化字段真的被读到了（防 snake_case/camelCase 错配复发）═══════════════
console.log("\n1. 结构化字段渲染");
{
  const { doc } = await boot(SITES);
  // 只取第一个 tbody：死链在独立的 .dead-group tbody 里，也会渲染额度单元格
  const quotas = Array.from(doc.querySelectorAll("tbody:first-of-type .quota-main")).map((e) => e.textContent.trim());
  check("高额度站显示 25 刀/天", quotas[0], "25 刀/天");
  check("中额度站显示积分与预估次数", quotas[1], "100 积分 ≈60次/天");
  check("无数值额度时回落到原文而非编造", quotas[2], "绑定账号即免费");
  check("活链分组里恰好 3 条", quotas.length, 3);

  // <tr> 的直接子元素必须是 <td>：曾经 makeTableRow 直接拼 <div>，
  // HTML 解析器会把它们移出表格（foster parenting），表格塌成一堆卡片。
  const firstRow = doc.querySelector("tbody:first-of-type tr[data-site-name]");
  const kids = Array.from(firstRow.children).map((c) => c.tagName);
  check("表格行的直接子元素全是 TD", [...new Set(kids)], ["TD"]);
  check("每行 7 个单元格，与表头列数一致", kids.length, 7);
  check("表头 7 列", doc.querySelectorAll("thead th").length, 7);
}

// ══ 2. 死链分组可达（防 matchesFilters 过滤掉死链的死锁复发）════════════════════
console.log("\n2. 死链分组");
{
  const { window, doc } = await boot(SITES);
  const btn = doc.querySelector(".dead-toggle-btn");
  check("展开按钮存在", !!btn, true);
  check("按钮文案带条数", btn.textContent.trim(), "已失效 (2) — 点击展开");
  check("分组默认折叠", doc.querySelector(".dead-group").hidden, true);
  check("aria-expanded 与折叠状态一致", btn.getAttribute("aria-expanded"), "false");
  check("死链行在分组内", doc.querySelectorAll(".dead-group tr").length, 2);
  check("tbody 未被非法嵌套", doc.querySelectorAll("tbody tbody").length, 0);
  click(window, btn);
  await tick();
  check("点击后展开", doc.querySelector(".dead-group").hidden, false);
  check("点击后 aria-expanded=true", doc.querySelector(".dead-toggle-btn").getAttribute("aria-expanded"), "true");
  check('"匹配 N 条"只数活链', doc.getElementById("resultCount").textContent, "5 条中匹配 3 条");
}

// ══ 3. 高级筛选面板不会被自己关掉 + 结果计数跟着更新 ═══════════════════════════
console.log("\n3. 高级筛选交互");
{
  const { window, doc } = await boot(SITES);
  click(window, doc.querySelector(".filter-toggle-btn"));
  await tick();
  check("面板展开", doc.getElementById("filterPanel").hidden, false);
  const chip = doc.querySelector("#filterPanel .filter-chip"); // 额度档位「高」
  click(window, chip);
  await tick();
  check("点选筛选项后面板仍展开", doc.getElementById("filterPanel").hidden, false);
  check("chip aria-pressed 已翻转", doc.querySelector("#filterPanel .filter-chip").getAttribute("aria-pressed"), "true");
  check("结果计数已刷新（只剩 1 条活的高额度）", doc.getElementById("resultCount").textContent, "2 条中匹配 1 条");
  check("清除筛选按钮出现", doc.getElementById("clearFiltersBtn").hidden, false);
}

// ══ 4. 抽屉：焦点管理与监听器不泄漏 ════════════════════════════════════════════
console.log("\n4. 详情抽屉");
{
  const { window, doc, liveKeydown } = await boot(SITES);
  const base = liveKeydown.size;
  for (const via of ["close", "overlay", "escape"]) {
    for (let i = 0; i < 5; i++) {
      click(window, doc.querySelectorAll(".btn-detail")[0]);
      await tick(10);
      if (via === "close") click(window, doc.querySelector(".drawer-close"));
      else if (via === "overlay") click(window, doc.querySelector(".drawer-overlay"));
      else doc.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await tick(320);
    }
    check(`经 ${via} 关闭 5 次后 document 上无残留 keydown 监听器`, liveKeydown.size, base);
  }
  check("无残留 overlay 节点", doc.querySelectorAll(".drawer-overlay").length, 0);
  click(window, doc.querySelectorAll(".btn-detail")[0]);
  await tick(30);
  const drawer = doc.querySelector(".drawer");
  check("抽屉是 dialog", drawer.getAttribute("role"), "dialog");
  check("aria-labelledby 指向真实存在的标题", !!doc.getElementById(drawer.getAttribute("aria-labelledby")), true);
}

// ══ 5. 排序方向与 aria-sort 一致 ═══════════════════════════════════════════════
console.log("\n5. 排序");
{
  const { window, doc } = await boot(SITES);
  const sel = doc.querySelector(".sort-select");
  const setSort = async (v) => { sel.value = v; sel.dispatchEvent(new window.Event("change", { bubbles: true })); await tick(); };
  const sorted = () => Array.from(doc.querySelectorAll("tbody:first-of-type tr[data-site-name]")).map((r) => r.dataset.siteName);

  await setSort("name");
  // localeCompare(…, "zh-CN") 按拼音排序，不是码位：高(gao) < 未(wei) < 中(zhong)
  check("按名称升序（拼音序）", sorted(), ["高额度站", "未知额度站", "中额度站"]);
  check("aria-sort=ascending", doc.querySelector(".col-name").getAttribute("aria-sort"), "ascending");

  await setSort("quota");
  check("按额度档位高→低", sorted(), ["高额度站", "中额度站", "未知额度站"]);
  check("aria-sort=descending", doc.querySelector(".col-quota").getAttribute("aria-sort"), "descending");
  check("表格不声明 role=grid（未实现方格键盘导航）", doc.querySelector(".site-table").getAttribute("role"), null);
}

// ══ 6. D1 时间戳按 UTC 解析 ════════════════════════════════════════════════════
console.log("\n6. 鲜度时间");
{
  const nowUtc = new Date().toISOString().slice(0, 19).replace("T", " ");
  const { doc } = await boot([
    makeSite({ name: "刚验证", slug: "s1", verifiedAt: nowUtc, verifiedBy: "healthcheck" }),
    makeSite({ name: "没验证", slug: "s2", verifiedAt: null }),
  ]);
  const labels = Array.from(doc.querySelectorAll(".fresh-label")).map((e) => e.textContent.trim());
  check("刚写入的 UTC 时间显示为「刚刚」而不是「8小时前」", labels[0], "刚刚");
  check("未验证如实显示「未验证」", labels[1], "未验证");
  const cls = doc.querySelector(".cell-fresh").className;
  check("鲜度为绿", cls.includes("fresh-green"), true);
}

// ══ 7. 额度文本：0 是有效额度，null 才是未知 ════════════════════════════════════
// 修复前的实测行为：min=null/max=50 → "null-50 积分/天"（把 null 印给用户）；
// min=0/max=0 与 min=0/max=null → "额度未知"（明确填了 0 却当成没填）。
// 管理后台补上结构化字段输入框之后，"只填上限"和"填 0"都能真填进来。
console.log("\n7. 额度文本的 0 与 null");
{
  const { doc } = await boot([
    makeSite({ name: "区间站", slug: "q1", quotaTier: "high", quotaMin: 25, quotaMax: 50, quotaUnit: "usd", quotaPeriod: "daily" }),
    makeSite({ name: "零额度站", slug: "q2", quotaTier: "low", quotaMin: 0, quotaMax: 0, quotaUnit: "usd", quotaPeriod: "daily" }),
    makeSite({ name: "只有上限站", slug: "q3", quotaTier: "mid", quotaMin: null, quotaMax: 50, quotaUnit: "credit", quotaPeriod: "daily" }),
    makeSite({ name: "真未知站", slug: "q4", quotaMin: null, quotaMax: null, quotaRaw: null }),
  ]);
  // 按行名取值，不按位置 —— 默认排序是按 quotaTier 降序，位置会变。
  const quotaOf = (siteName) => {
    const row = Array.from(doc.querySelectorAll("tbody:first-of-type tr")).find(
      (tr) => tr.querySelector(".site-name")?.textContent.trim() === siteName
    );
    return row?.querySelector(".quota-main")?.textContent.trim();
  };
  const allTexts = Array.from(doc.querySelectorAll("tbody:first-of-type .quota-main")).map((e) => e.textContent.trim());
  check("区间正常显示", quotaOf("区间站"), "25-50 刀/天");
  check("明确的 0 显示为「0 刀/天」而不是「额度未知」", quotaOf("零额度站"), "0 刀/天");
  check("只有上限时不把 null 印出来", quotaOf("只有上限站"), "最多 50 积分/天");
  check("没有任何 null 字样漏进页面", allTexts.some((t) => t.includes("null")), false);
  check("真未知如实显示「额度未知」", quotaOf("真未知站"), "额度未知");
}

// ── 汇总 ──────────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(60)}`);
if (failures.length === 0) {
  console.log(`✅ test-frontend: ${passed} 项断言全部通过`);
  process.exit(0);
}
console.error(`❌ test-frontend: ${passed} 项通过，${failures.length} 项失败\n`);
failures.forEach((f, i) => console.error(`  ${i + 1}. ${f}`));
process.exit(1);
