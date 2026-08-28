#!/usr/bin/env node
/**
 * test-admin-form.mjs — 管理后台编辑表单的行为回归（jsdom 驱动真实页面脚本）
 *
 * 为什么需要它：
 *   admin 页面的表单、回填、提交是三段分开的代码，改一处漏两处非常容易，
 *   而且漏了不会报错 —— 表单上有输入框、点保存也提示"成功"，只是值没发出去。
 *   实测发生过：后端 API 早就能收 13 个结构化字段，表单里一个输入框都没有，
 *   于是从后台新建的站点额度永远是"未知"。
 *
 * 为什么 eval 源码而不是直接加载 /admin 的 HTML：
 *   线上 /admin 的脚本是 Vite 产物 <script type="module">，而 jsdom 不执行
 *   ES module —— 旧版实现抓线上 HTML 后 window.showCreate 等桥接函数根本
 *   不存在，整份测试从未真正跑起来。这里改为：本地 admin.html 提供 DOM
 *   骨架 + eval(admin-raw.js)（无 import 的普通脚本，与 /tmp 审计 harness 同法），
 *   不再依赖运行中的 worker。
 *
 * 用法：
 *   node scripts/test-admin-form.mjs [http://127.0.0.1:8799]
 *   没装 jsdom 时自动跳过，退出码 0。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.argv[2] || "http://127.0.0.1:8799").replace(/\/$/, "");

let JSDOM;
try {
  ({ JSDOM } = await import("jsdom"));
} catch {
  console.log("⏭️  未安装 jsdom，跳过管理后台表单测试");
  process.exit(0);
}

const html = readFileSync(path.join(ROOT, "frontend/admin.html"), "utf8");
const js = readFileSync(path.join(ROOT, "frontend/src/admin-raw.js"), "utf8");

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; console.log(`  ✅ ${name}`); }
  else { failures.push(`${name}\n       期望: ${JSON.stringify(expected)}\n       实际: ${JSON.stringify(actual)}`); console.log(`  ❌ ${name}`); }
}

// 记录页面发出的每一个请求，供断言用
const sent = [];
// 页面里的 SITES 是 `let SITES = []`（脚本词法作用域，不挂 window），
// 所以不能 win.SITES=... 注入，必须让它走正常的 loadSites() 路径。
const state = { sites: [] };
const dom = new JSDOM(html, {
  runScripts: "dangerously",
  resources: "usable",
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
    // 正确的管理端 token 键（应用读的就是这个键；旧版写成 adminToken）
    win.localStorage.setItem("sk-free-admin-token", "localtest123");
  },
});
const win = dom.window;
const doc = win.document;
win.eval(js); // 注入真实管理脚本（window 桥接函数由此可用）
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

console.log("\n8. 扫描对账报告：多选 + 批量操作 + 原位更新");
{
  // 真实事故回归：旧版报告每行只有单行按钮（N 条要点 N 次），且点一次
  // setDeadByName → renderHealthFromSites 会用 DB 视图覆盖整份报告，
  // 剩余待处理行全部丢失。本组锁定：全选/多选/批量/处理后原位移除。
  const SITES_SEED = [
    { name: "坏站A", url: "https://bad-a.example.com/", tags: [], summary: "", enabled: true, dead: false, healthFailCount: 0, verifiedAt: null, verifiedBy: null, votes: { up: 0, down: 0 }, notes: [] },
    { name: "坏站B", url: "https://bad-b.example.com/", tags: [], summary: "", enabled: true, dead: false, healthFailCount: 0, verifiedAt: null, verifiedBy: null, votes: { up: 0, down: 0 }, notes: [] },
    { name: "好站C", url: "https://good-c.example.com/", tags: [], summary: "", enabled: false, dead: true, healthFailCount: 0, verifiedAt: null, verifiedBy: null, votes: { up: 0, down: 0 }, notes: [] },
  ];
  state.sites = SITES_SEED;
  // 路由化 fetch stub：check-batch 返回探测结果，sites/batch 记录并回显 affected
  win.fetch = async (url, opts = {}) => {
    const u = String(url);
    sent.push({ url: u, method: opts.method || "GET", body: opts.body ? JSON.parse(opts.body) : null });
    if (u.includes("/api/admin/check-batch")) {
      return { ok: true, status: 200, json: async () => ({
        ok: true, total: 3, alive: 1, dead: 2, maxBatch: 20, truncated: false,
        results: [
          { url: "https://bad-a.example.com/", ok: false, status: 521, method: "GET" },
          { url: "https://bad-b.example.com/", ok: false, status: 0, error: "timeout", method: "HEAD" },
          { url: "https://good-c.example.com/", ok: true, status: 200, method: "HEAD" },
        ],
      }) };
    }
    if (u.includes("/api/admin/sites/batch")) {
      const body = JSON.parse(opts.body || "{}");
      return { ok: true, status: 200, json: async () => ({ ok: true, action: body.action, affected: (body.names || []).length }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, sites: state.sites, submissions: [], deadUrls: [], feedbacks: [], total: 0 }), text: async () => "{}" };
  };
  win.confirm = () => true; // 兜底（现用自定义 confirm 弹窗，真正的放行走 confirmResolve）

  // 批量标记为死链会弹自定义确认框（showConfirm），必须 confirmResolve(true) 放行，
  // 否则 scanApply await 在确认 promise 上挂起，后续断言全部落空。
  await win.loadSites();
  sent.length = 0;
  const markPromise = win.batchCheckUrls();
  await new Promise((r) => setTimeout(r, 80));
  await markPromise;
  await new Promise((r) => setTimeout(r, 60));

  const markBody = idOf("scanMarkBody");
  const restoreBody = idOf("scanRestoreBody");
  check("报告渲染出『不可达但可用』区", markBody?.querySelectorAll("tr").length, 2);
  check("报告渲染出『可达但死链』区", restoreBody?.querySelectorAll("tr").length, 1);
  check("批量按钮存在（标记）", !!doc.querySelector("#scanMarkSection button"), true);
  check("批量按钮存在（恢复）", !!doc.querySelector("#scanRestoreSection button"), true);
  check("初始计数为 0", idOf("scanMarkCount").textContent, "已选 0 个");

  // 全选标记区 → 计数联动
  const markAll = doc.querySelector('#scanMarkSection input[data-scan-all]');
  markAll.checked = true;
  win.scanToggleAll(markAll);
  check("全选后计数联动", idOf("scanMarkCount").textContent, "已选 2 个");

  // 批量标记为死链 → 请求体正确 + 行被原位移除 + 报告不被覆盖
  const applyPromise = win.scanBatchMark();
  await new Promise((r) => setTimeout(r, 80)); // 等 showConfirm 弹窗出现
  win.confirmResolve(true);
  await applyPromise;
  await new Promise((r) => setTimeout(r, 60));
  const batchCalls = sent.filter((s) => s.url.includes("/api/admin/sites/batch"));
  check("批量请求发出", batchCalls.length, 1);
  check("批量 action=disable 且带上两个勾选站", [batchCalls[0]?.body?.action, batchCalls[0]?.body?.names], ["disable", ["坏站A", "坏站B"]]);
  check("已处理行从报告原位移除", markBody.querySelectorAll("tr").length, 0);
  check("标记区替换为完成提示", doc.getElementById("scanMarkSection").textContent.includes("处理完毕"), true);
  check("另一区不受影响（报告未被覆盖）", restoreBody.querySelectorAll("tr").length, 1);

  // 单行恢复 → 走同一原位逻辑
  await win.scanOne(restoreBody.querySelector("button"), false);
  await new Promise((r) => setTimeout(r, 60));
  const restoreCalls = sent.filter((s) => s.url.includes("/api/admin/sites/batch") && s.body?.action === "enable");
  check("单行恢复请求体正确", restoreCalls[0]?.body?.names, ["好站C"]);
  check("恢复区也清空并提示完成", doc.getElementById("scanRestoreSection").textContent.includes("处理完毕"), true);
}

console.log(`\n${"─".repeat(60)}`);
if (failures.length === 0) {
  console.log(`✅ test-admin-form: ${passed} 项断言全部通过`);
  process.exit(0);
}
console.error(`❌ test-admin-form: ${passed} 项通过，${failures.length} 项失败\n`);
failures.forEach((f, i) => console.error(`  ${i + 1}. ${f}`));
process.exit(1);
