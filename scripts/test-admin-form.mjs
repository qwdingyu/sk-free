#!/usr/bin/env node
/**
 * test-admin-form.mjs — 管理后台编辑表单的行为回归（jsdom 驱动真实页面脚本）
 *
 * 为什么需要它：
 *   admin 页面的表单、回填、提交是三段分开的代码，改一处漏两处非常容易，
 *   而且漏了不会报错 —— 表单上有输入框、点保存也提示"成功"，只是值没发出去。
 *   实测发生过：后端 API 早就能收 13 个结构化字段，表单里一个输入框都没有，
 *   于是从后台新建的站点额度永远是"未知"。
 *   这个测试直接把线上 /admin 的 HTML 喂给 jsdom，stub 掉 fetch，
 *   然后断言"填进输入框的值确实出现在请求体里"。
 *
 * 用法：
 *   （先起本地 worker）node scripts/test-admin-form.mjs http://127.0.0.1:8799 localtest123
 *   没装 jsdom 时自动跳过，退出码 0。
 */

const BASE = (process.argv[2] || "http://127.0.0.1:8799").replace(/\/$/, "");

let JSDOM;
try {
  ({ JSDOM } = await import("jsdom"));
} catch {
  console.log("⏭️  未安装 jsdom，跳过管理后台表单测试");
  process.exit(0);
}

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; console.log(`  ✅ ${name}`); }
  else { failures.push(`${name}\n       期望: ${JSON.stringify(expected)}\n       实际: ${JSON.stringify(actual)}`); console.log(`  ❌ ${name}`); }
}

const html = await (await fetch(`${BASE}/admin`)).text();

// 记录页面发出的每一个请求，供断言用
const sent = [];
// 页面里的 SITES 是 `let SITES = []`（脚本词法作用域，不挂 window），
// 所以不能 win.SITES=... 注入，必须让它走正常的 loadSites() 路径。
const state = { sites: [] };
const dom = new JSDOM(html, {
  runScripts: "dangerously",
  url: `${BASE}/admin`,
  beforeParse(win) {
    win.fetch = async (url, opts = {}) => {
      sent.push({ url: String(url), method: opts.method || "GET", body: opts.body ? JSON.parse(opts.body) : null });
      // 让页面初始化时的各种 GET 拿到形状正确的空响应
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, sites: state.sites, submissions: [], deadUrls: [], feedbacks: [], total: 0 }),
        text: async () => "{}",
      };
    };
    win.localStorage.setItem("adminToken", "localtest123");
  },
});
const win = dom.window;
const doc = win.document;
// 等页面上的 DOMContentLoaded 初始化跑完
await new Promise((r) => setTimeout(r, 400));

const set = (id, v) => { const el = doc.getElementById(id); el.value = v; };
const idOf = (id) => doc.getElementById(id);

console.log("\n1. 结构化字段的输入框存在且是正确的控件类型");
{
  for (const id of ["editQuotaTier", "editQuotaUnit", "editQuotaPeriod", "editKind", "editNeedsProxy"]) {
    check(`${id} 是 <select>`, idOf(id)?.tagName, "SELECT");
  }
  for (const id of ["editQuotaMin", "editQuotaMax", "editQuotaCallsEst"]) {
    check(`${id} 是 number 输入框`, idOf(id)?.getAttribute("type"), "number");
  }
  check("editQuotaRaw 存在", !!idOf("editQuotaRaw"), true);
  check("editSlug 存在", !!idOf("editSlug"), true);
  // 枚举选项必须与 worker/src/sites.js 完全一致，多一个少一个都会导致 400
  const opts = (id) => [...idOf(id).options].map((o) => o.value);
  check("quotaTier 选项", opts("editQuotaTier"), ["", "high", "mid", "low", "none"]);
  check("quotaUnit 选项", opts("editQuotaUnit"), ["", "usd", "cny", "credit", "coin", "token", "call"]);
  check("quotaPeriod 选项", opts("editQuotaPeriod"), ["", "daily", "weekly", "once", "none"]);
  check("kind 选项", opts("editKind"), ["", "api_site", "bot", "account_pool", "tool"]);
  check("needsProxy 选项", opts("editNeedsProxy"), ["", "1", "0"]);
}

console.log("\n2. 填进去的结构化字段确实进了请求体");
{
  win.showCreate();
  set("editName", "表单测试站");
  set("editUrl", "https://form.example.com");
  set("editQuotaTier", "high");
  set("editQuotaMin", "25");
  set("editQuotaMax", "50");
  set("editQuotaUnit", "usd");
  set("editQuotaPeriod", "daily");
  set("editQuotaCallsEst", "100");
  set("editQuotaRaw", "每日 25-50 刀");
  set("editKind", "api_site");
  set("editNeedsProxy", "1");
  set("editSlug", "form-test");
  sent.length = 0;
  await win.saveSite();
  await new Promise((r) => setTimeout(r, 60));
  const post = sent.find((s) => s.method === "POST" && s.url.includes("/api/admin/sites"));
  check("发出了 POST 创建请求", !!post, true);
  const b = post?.body || {};
  check("quotaTier", b.quotaTier, "high");
  check("quotaMin 是数字 25", b.quotaMin, 25);
  check("quotaMax 是数字 50", b.quotaMax, 50);
  check("quotaUnit", b.quotaUnit, "usd");
  check("quotaPeriod", b.quotaPeriod, "daily");
  check("quotaCallsEst 是数字 100", b.quotaCallsEst, 100);
  check("quotaRaw", b.quotaRaw, "每日 25-50 刀");
  check("kind", b.kind, "api_site");
  check("needsProxy 是数字 1", b.needsProxy, 1);
  check("slug", b.slug, "form-test");
}

console.log("\n3. 留空 = 显式 null（能把字段改回未知），且键必须存在");
{
  win.showCreate();
  set("editName", "全空站");
  set("editUrl", "https://empty.example.com");
  sent.length = 0;
  await win.saveSite();
  await new Promise((r) => setTimeout(r, 60));
  const b = sent.find((s) => s.method === "POST")?.body || {};
  for (const k of ["quotaTier", "quotaMin", "quotaUnit", "quotaPeriod", "quotaCallsEst", "quotaRaw", "kind", "needsProxy", "slug"]) {
    // 后端用 pick() 按"键是否存在"判断，键丢了就变成"不修改"，改不回未知
    check(`${k} 键存在且为 null`, Object.prototype.hasOwnProperty.call(b, k) ? b[k] : "键丢了", null);
  }
}

console.log("\n4. 数值 0 不能被当成未设置");
{
  win.showCreate();
  set("editName", "零额度站");
  set("editUrl", "https://zero.example.com");
  set("editQuotaMin", "0");
  set("editNeedsProxy", "0");
  sent.length = 0;
  await win.saveSite();
  await new Promise((r) => setTimeout(r, 60));
  const b = sent.find((s) => s.method === "POST")?.body || {};
  check("quotaMin=0 发出的是数字 0（不是 null）", b.quotaMin, 0);
  check("needsProxy=0 发出的是数字 0（不是 null）", b.needsProxy, 0);
}

console.log("\n5. 回填：编辑已有站点时结构化字段要显示出来");
{
  state.sites = [{
    name: "回填站", url: "https://back.example.com", tags: [], summary: "", checkin: "",
    models: "", rate: "", register: "", ref: "", originalUrl: "", notes: [],
    quotaTier: "mid", quotaMin: 0, quotaMax: 10, quotaUnit: "credit", quotaPeriod: "once",
    quotaCallsEst: null, quotaRaw: "限免", kind: "bot", needsProxy: 0, slug: "back-1",
    votes: { up: 0, down: 0 }, enabled: true,
  }];
  await win.loadSites();
  await new Promise((r) => setTimeout(r, 80));
  win.showCreate(); // 先清空，避免上一节的残留值把漏填伪装成通过
  win.showEdit("回填站");
  check("quotaTier 回填", idOf("editQuotaTier").value, "mid");
  check("quotaMin=0 回填成 '0' 而不是空", idOf("editQuotaMin").value, "0");
  check("quotaMax 回填", idOf("editQuotaMax").value, "10");
  check("needsProxy=0 回填成 '0' 而不是空", idOf("editNeedsProxy").value, "0");
  check("quotaCallsEst=null 回填成空", idOf("editQuotaCallsEst").value, "");
  check("quotaUnit 回填", idOf("editQuotaUnit").value, "credit");
  check("quotaPeriod 回填", idOf("editQuotaPeriod").value, "once");
  check("quotaRaw 回填", idOf("editQuotaRaw").value, "限免");
  check("kind 回填", idOf("editKind").value, "bot");
  check("slug 回填", idOf("editSlug").value, "back-1");
}

console.log("\n6. 提交前的方向性校验");
{
  win.showCreate();
  set("editName", "区间反了站");
  set("editUrl", "https://bad.example.com");
  set("editQuotaMin", "50");
  set("editQuotaMax", "5");
  sent.length = 0;
  await win.saveSite();
  await new Promise((r) => setTimeout(r, 60));
  check("上限小于下限时不发请求", sent.filter((s) => s.method === "POST").length, 0);
}

console.log("\n7. 新增表单要清空上一次残留的结构化字段");
{
  win.showEdit("回填站");
  win.showCreate();
  check("quotaTier 已清空", idOf("editQuotaTier").value, "");
  check("quotaMin 已清空", idOf("editQuotaMin").value, "");
  check("slug 已清空", idOf("editSlug").value, "");
}

console.log(`\n${"─".repeat(60)}`);
if (failures.length === 0) {
  console.log(`✅ test-admin-form: ${passed} 项断言全部通过`);
  process.exit(0);
}
console.error(`❌ test-admin-form: ${passed} 项通过，${failures.length} 项失败\n`);
failures.forEach((f, i) => console.error(`  ${i + 1}. ${f}`));
process.exit(1);
