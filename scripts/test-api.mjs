#!/usr/bin/env node
/**
 * test-api.mjs — 后端 HTTP API 集成测试（打真实 Worker + 真实 D1）
 *
 * 为什么需要它：
 *   worker/src/ 里的合并语义（?? 保留原值 vs pick() 按键存在判断）光看代码
 *   非常容易看错，而看错的代价是静默的数据丢失或"保存了但改不掉"。
 *   已经真实发生过：
 *     - 改名走 DELETE+INSERT 只重写 14 列，13 个结构化字段静默清空
 *     - 管理后台清空文本字段发的是 undefined，JSON.stringify 丢键，
 *       后端按"不修改"处理，接口返回 ok 但值改不掉
 *   这两个都只有打真实接口才能发现，读代码和单测都容易放过。
 *
 * 用法：
 *   cd worker
 *   printf 'ADMIN_TOKEN=localtest123\n' > .dev.vars
 *   for m in 0001_init_up 0002_add_feedbacks_up 0003_structured_quota_up 0004_fix_feedbacks_type_up; do
 *     npx wrangler d1 execute SKFREE_DB --local --file "migrations/$m.sql"
 *   done
 *   npx wrangler dev --local --port 8799 &
 *   node ../scripts/test-api.mjs http://127.0.0.1:8799 localtest123
 *
 * 绝对不要对生产跑：它会创建/改名/删除站点。脚本会拒绝非本地地址。
 */

const BASE = (process.argv[2] || "http://127.0.0.1:8799").replace(/\/$/, "");
const TOKEN = process.argv[3] || "localtest123";

if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASE)) {
  console.error(`🚫 拒绝执行：${BASE} 不是本地地址。本脚本会创建/改名/删除站点，只能打本地 wrangler dev。`);
  process.exit(1);
}

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else {
    failures.push(`${name}\n       期望: ${JSON.stringify(expected)}\n       实际: ${JSON.stringify(actual)}`);
    console.log(`  ❌ ${name}  期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

const admin = (path, method, body) =>
  fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const pub = (path, method, body) =>
  fetch(`${BASE}${path}`, {
    method: method || "GET",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const getSite = async (name) => {
  const d = await (await pub("/api/sites")).json();
  return d.sites.find((s) => s.name === name);
};
const enc = encodeURIComponent;

const NAME = "集成测试站";
const NAME2 = "集成测试站改名后";

// 清理上一轮可能残留的数据
for (const n of [NAME, NAME2]) await admin(`/api/admin/sites/${enc(n)}`, "DELETE");

// ══ 1. 创建：结构化字段应被完整接受 ═══════════════════════════════════════════
console.log("\n1. 创建站点（结构化字段）");
{
  const r = await admin("/api/admin/sites", "POST", {
    name: NAME, url: "https://integration.example.com", tags: ["api", "签到"],
    summary: "集成测试用", checkin: "每日签到", models: "gpt-4", rate: "1.0",
    register: "邮箱", notes: ["备注一", "备注二"],
    slug: "integration-1", kind: "api_site",
    quotaMin: 25, quotaMax: 25, quotaUnit: "usd", quotaPeriod: "daily",
    quotaCallsEst: 100, quotaTier: "high", quotaRaw: "25 刀/天", needsProxy: 1,
  });
  check("HTTP 201 Created", r.status, 201);
  const s = await getSite(NAME);
  check("quotaTier 落库", s?.quotaTier, "high");
  check("quotaMin 落库", s?.quotaMin, 25);
  check("quotaUnit 落库", s?.quotaUnit, "usd");
  check("quotaCallsEst 落库", s?.quotaCallsEst, 100);
  check("needsProxy 落库", s?.needsProxy, 1);
  check("slug 落库", s?.slug, "integration-1");
  check("notes 落库", s?.notes, ["备注一", "备注二"]);
  check("新建站点 verifiedAt 为 null（不许伪造鲜度）", s?.verifiedAt, null);
}

// ══ 2. 更新：省略结构化字段 ⇒ 保留（不能静默清空）═════════════════════════════
console.log("\n2. 更新时省略结构化字段");
{
  await admin(`/api/admin/sites/${enc(NAME)}`, "PUT", {
    name: NAME, url: "https://integration.example.com", tags: ["api"], summary: "改了摘要",
  });
  const s = await getSite(NAME);
  check("summary 已更新", s?.summary, "改了摘要");
  check("quotaTier 保留", s?.quotaTier, "high");
  check("quotaMin 保留", s?.quotaMin, 25);
  check("slug 保留", s?.slug, "integration-1");
  check("needsProxy 保留", s?.needsProxy, 1);
}

// ══ 3. 更新：文本字段发 "" ⇒ 必须真的清空 ════════════════════════════════════
console.log("\n3. 清空文本字段（管理后台的清空操作）");
{
  await admin(`/api/admin/sites/${enc(NAME)}`, "PUT", {
    name: NAME, url: "https://integration.example.com", tags: ["api"], summary: "改了摘要",
    checkin: "", models: "", rate: "", register: "", ref: "", originalUrl: "", notes: [],
  });
  const s = await getSite(NAME);
  check("checkin 已清空", s?.checkin, "");
  check("models 已清空", s?.models, "");
  check("rate 已清空", s?.rate, "");
  check("register 已清空", s?.register, "");
  check("notes 已清空", s?.notes, []);
  check("清空文本字段不影响结构化字段", s?.quotaTier, "high");
}

// ══ 4. 更新：显式传 null ⇒ 把结构化字段改回"未知" ═════════════════════════════
console.log("\n4. 显式把结构化字段设回 null");
{
  await admin(`/api/admin/sites/${enc(NAME)}`, "PUT", {
    name: NAME, url: "https://integration.example.com", tags: ["api"],
    quotaTier: null, quotaMin: null, quotaUnit: null,
  });
  const s = await getSite(NAME);
  check("quotaTier 变 null", s?.quotaTier, null);
  check("quotaMin 变 null", s?.quotaMin, null);
  check("未提及的 slug 仍保留", s?.slug, "integration-1");
  // 复原，供后续用例
  await admin(`/api/admin/sites/${enc(NAME)}`, "PUT", {
    name: NAME, url: "https://integration.example.com", tags: ["api"],
    quotaTier: "high", quotaMin: 25, quotaUnit: "usd",
  });
}

// ══ 5. 枚举校验：写错的档位/单位必须被挡在入口 ═════════════════════════════════
console.log("\n5. 结构化字段枚举校验");
{
  const bad = async (patch) => {
    const r = await admin(`/api/admin/sites/${enc(NAME)}`, "PUT", { name: NAME, url: "https://integration.example.com", tags: ["api"], ...patch });
    return r.status;
  };
  check("quotaTier=超高 → 400", await bad({ quotaTier: "超高" }), 400);
  check("quotaUnit=rmb → 400", await bad({ quotaUnit: "rmb" }), 400);
  check("kind=unknown_kind → 400", await bad({ kind: "unknown_kind" }), 400);
  check("quotaPeriod=hourly → 400", await bad({ quotaPeriod: "hourly" }), 400);
  const s = await getSite(NAME);
  check("被拒的请求没有部分写入", s?.quotaTier, "high");
}

// ══ 6. 投票与反馈 ═════════════════════════════════════════════════════════════
console.log("\n6. 投票与一键反馈");
{
  check("投 up", (await pub("/api/vote", "POST", { siteName: NAME, type: "up" })).status, 200);
  const s = await getSite(NAME);
  check("票数已累计", s?.votes, { up: 1, down: 0 });

  // 表格视图的 👍/👎 发的是空 content —— 曾经后端要求 ≥2 字符，100% 失败
  for (const t of ["still_works", "reported_dead"]) {
    const r = await pub("/api/feedback", "POST", { siteName: NAME, type: t, content: "" });
    // 201 Created：表格视图的 👍/👎 发的就是空 content，曾经后端要求 ≥2 字符 → 100% 400
    check(`一键反馈 ${t}（空 content）成功`, r.status, 201);
  }
  // 需要正文的类型仍应拦住。
  // 注意：这里必须用后端白名单里真实存在的类型（error/correction/positive），
  // 否则 400 是"类型非法"给出的，测不到"正文太短"这条分支 ——
  // 第一版写了个不存在的 quota_changed，断言通过但通过的原因是错的。
  for (const t of ["error", "correction", "positive"]) {
    const r = await pub("/api/feedback", "POST", { siteName: NAME, type: t, content: "" });
    check(`${t} 空正文 → 400`, r.status, 400);
    const ok = await pub("/api/feedback", "POST", { siteName: NAME, type: t, content: "内容足够长" });
    check(`${t} 有正文 → 成功`, ok.status, 201);
  }
  const r3 = await pub("/api/feedback", "POST", { siteName: NAME, type: "garbage_type", content: "有效正文" });
  check("非法反馈类型 → 400", r3.status, 400);
}

// ══ 7. 改名：id 与全部字段必须原样保留，关联表要一起搬 ════════════════════════
console.log("\n7. 改名");
{
  const before = await getSite(NAME);
  const r = await admin(`/api/admin/sites/${enc(NAME)}`, "PUT", {
    name: NAME2, url: before.url, tags: before.tags, summary: before.summary,
  });
  check("HTTP 200", r.status, 200);
  check("旧名已不存在", await getSite(NAME), undefined);
  const after = await getSite(NAME2);
  check("quotaTier 保留", after?.quotaTier, before.quotaTier);
  check("quotaMin 保留", after?.quotaMin, before.quotaMin);
  check("quotaUnit 保留", after?.quotaUnit, before.quotaUnit);
  check("slug 保留", after?.slug, before.slug);
  check("quotaCallsEst 保留", after?.quotaCallsEst, before.quotaCallsEst);
  check("needsProxy 保留", after?.needsProxy, before.needsProxy);
  check("createdAt 保留（说明不是新建的行）", after?.createdAt, before.createdAt);
  check("票数随改名迁移（votes 表 site_name 已更新）", after?.votes, { up: 1, down: 0 });
}

// ══ 8. 唯一性冲突 ═════════════════════════════════════════════════════════════
console.log("\n8. 唯一性约束");
{
  await admin("/api/admin/sites", "POST", { name: "占位站", url: "https://placeholder.example.com", tags: [], slug: "placeholder-1" });
  const dupName = await admin("/api/admin/sites", "POST", { name: NAME2, url: "https://other.example.com", tags: [] });
  check("重名创建 → 409", dupName.status, 409);
  const dupSlug = await admin(`/api/admin/sites/${enc(NAME2)}`, "PUT", { name: NAME2, url: "https://integration.example.com", tags: [], slug: "placeholder-1" });
  check("slug 撞车 → 409", dupSlug.status, 409);
  await admin(`/api/admin/sites/${enc("占位站")}`, "DELETE");
}

// ══ 9. 鉴权 ═══════════════════════════════════════════════════════════════════
console.log("\n9. 鉴权");
{
  const noAuth = await fetch(`${BASE}/api/admin/sites`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "无授权", url: "https://x.example.com", tags: [] }) });
  check("无 token 创建 → 401", noAuth.status, 401);
  const badAuth = await fetch(`${BASE}/api/admin/sites`, { method: "POST", headers: { Authorization: "Bearer wrong", "Content-Type": "application/json" }, body: JSON.stringify({ name: "错token", url: "https://x.example.com", tags: [] }) });
  check("错误 token 创建 → 401", badAuth.status, 401);
  check("被拒后没有落库", await getSite("无授权"), undefined);
}

// ══ 10. 删除 ══════════════════════════════════════════════════════════════════
console.log("\n10. 删除");
{
  check("删除 → 200", (await admin(`/api/admin/sites/${enc(NAME2)}`, "DELETE")).status, 200);
  check("已从列表消失", await getSite(NAME2), undefined);
  check("删除不存在的站点 → 404", (await admin(`/api/admin/sites/${enc("根本没有这个站")}`, "DELETE")).status, 404);
}

// ══ 11. 导入：结构化字段应被完整接受 ══════════════════════════════════════════
console.log("\n11. 导入（含结构化字段）");
{
  const importData = [
    { name: "导入站A", url: "https://import-a.example.com", tags: ["签到"], kind: "api_site", quotaTier: "high", quotaMin: 25, quotaMax: 25, quotaUnit: "usd", quotaPeriod: "daily", checkin: "每日 25 刀" },
    { name: "导入站B", url: "https://import-b.example.com", tags: [], kind: "bot", quotaTier: "low", quotaMin: 1, quotaUnit: "credit", quotaPeriod: "daily" },
    // 旧版导出格式：不含结构化字段，应能正常导入并用默认值
    { name: "导入站C（旧版）", url: "https://import-c.example.com", tags: [], summary: "无结构化字段" },
  ];
  const r = await admin("/api/admin/sites/import", "POST", { sites: importData });
  check("导入 → 200", r.status, 200);
  const result = await r.json();
  check("3 条全部新增", result.added, 3);
  check("无重复/跳过", result.skipped, 0);

  const sA = await getSite("导入站A");
  check("导入站A kind 落库", sA?.kind, "api_site");
  check("导入站A quotaTier 落库", sA?.quotaTier, "high");
  check("导入站A quotaMin 落库", sA?.quotaMin, 25);
  check("导入站A quotaRaw 用 checkin 兜底", sA?.quotaRaw, "每日 25 刀");

  const sB = await getSite("导入站B");
  check("导入站B kind 落库", sB?.kind, "bot");
  check("导入站B quotaTier 落库", sB?.quotaTier, "low");

  const sC = await getSite("导入站C（旧版）");
  check("旧版导入 kind 默认 api_site", sC?.kind, "api_site");
  check("旧版导入 quotaTier 默认 none", sC?.quotaTier, "none");
  check("旧版导入 quotaPeriod 默认 none", sC?.quotaPeriod, "none");

  // 清理
  for (const n of ["导入站A", "导入站B", "导入站C（旧版）"]) await admin(`/api/admin/sites/${enc(n)}`, "DELETE");
}

// ══ 12. 提交批准：结构化字段默认值 ════════════════════════════════════════════
console.log("\n12. 提交批准（结构化字段默认值）");
{
  // 用户提交
  const subR = await pub("/api/submit", "POST", { name: "提交批准站", url: "https://approve.example.com", tags: [], summary: "通过提交创建" });
  check("用户提交 → 201", subR.status, 201);

  // 管理员获取待审核列表
  const subs = await (await admin("/api/admin/submissions", "GET")).json();
  const sub = subs.submissions?.find((s) => s.site.name === "提交批准站");
  check("待审核提交存在", !!sub, true);

  // 原子批准
  const approveR = await admin(`/api/admin/submissions/${enc(sub.id)}/approve`, "POST");
  check("批准 → 201", approveR.status, 201);

  const site = await getSite("提交批准站");
  check("批准站 kind 默认 api_site", site?.kind, "api_site");
  check("批准站 quotaTier 默认 none", site?.quotaTier, "none");
  check("批准站 quotaPeriod 默认 none", site?.quotaPeriod, "none");
  check("批准站 url 已入库", site?.url, "https://approve.example.com/");

  // 清理
  await admin(`/api/admin/sites/${enc("提交批准站")}`, "DELETE");
}

// ══ 13. 死链接移除 → 站点自动恢复启用（URL 尾斜杠必须容差）═══════════════════
// sites.url 经 parseSiteUrl 规范化后带尾斜杠（https://x.com → https://x.com/），
// dead_urls.url 存的是调用方原样传的字符串。两边形式不一致时，
// "移除死链 → 恢复站点启用"这条联动会静默失效，而 UI 文案承诺了它会生效。
// 实测过：不带尾斜杠移除 → enabled 仍是 0；带尾斜杠 → 恢复为 1。
console.log("\n11. 死链接移除与站点启用联动");
{
  const DN = "死链联动站";
  await admin(`/api/admin/sites/${enc(DN)}`, "DELETE");
  await admin("/api/admin/sites", "POST", { name: DN, url: "https://deadlink.example.com", tags: [] });
  const stored = (await getSite(DN))?.url;
  check("站点 URL 入库时被规范化（带尾斜杠）", stored, "https://deadlink.example.com/");

  for (const form of ["https://deadlink.example.com", "https://deadlink.example.com/"]) {
    const label = form.endsWith("/") ? "带尾斜杠" : "不带尾斜杠";
    await admin("/api/admin/dead-urls/batch", "POST", { action: "add", urls: [form] });
    await admin(`/api/admin/sites/batch`, "POST", { action: "disable", names: [DN] });
    const before = await getSite(DN);
    check(`${label}：先确认站点已停用`, before, undefined); // 停用后不在公开列表里
    const rm = await admin("/api/admin/dead-urls/batch", "POST", { action: "remove", urls: [form] });
    check(`${label}：批量移除 → 200`, rm.status, 200);
    const after = await getSite(DN);
    check(`${label}：站点自动恢复启用（重新出现在公开列表）`, after?.name, DN);
  }
  await admin(`/api/admin/sites/${enc(DN)}`, "DELETE");
}

console.log(`\n${"─".repeat(60)}`);
if (failures.length === 0) {
  console.log(`✅ test-api: ${passed} 项断言全部通过`);
  process.exit(0);
}
console.error(`❌ test-api: ${passed} 项通过，${failures.length} 项失败\n`);
failures.forEach((f, i) => console.error(`  ${i + 1}. ${f}`));
process.exit(1);
