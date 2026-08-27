
let TOKEN = localStorage.getItem("sk-free-admin-token") || "";
let SITES = [];
let SELECTED = new Set();
let DEAD_URLS = new Map(); // url -> { added_at, status, reason, error }（死链库）
let SITE_PAGE = 1;
let SITE_LIMIT = 20;
let ALL_TAGS = []; // 缓存全量标签，避免分页后标签过滤选项丢失
async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { "Content-Type": "application/json", "Authorization": "Bearer " + TOKEN, ...(opts.headers || {}) } });
  if (res.status === 401) { doLogout(); throw new Error("登录已过期"); }
  if (path.includes("/export")) return res;
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "请求失败");
  return data;
}
(function() {
  var KEY = "admin-theme";
  function applyTheme(choice) {
    var resolved = choice === "system" ? (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : choice;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themeChoice = choice;
    document.querySelectorAll("[data-admin-theme]").forEach(function(btn) { btn.classList.toggle("active", btn.dataset.adminTheme === choice); });
    try { localStorage.setItem(KEY, choice); } catch {}
  }
  document.addEventListener("click", function(e) { var btn = e.target.closest("[data-admin-theme]"); if (btn) applyTheme(btn.dataset.adminTheme); });
  var saved = "system"; try { saved = localStorage.getItem(KEY) || "system"; } catch {} applyTheme(saved);
})();
function doLogin() {
  TOKEN = document.getElementById("tokenInput").value.trim();
  if (!TOKEN) return;
  localStorage.setItem("sk-free-admin-token", TOKEN);
  loadSites().then(() => loadDeadUrls()).then(() => { document.getElementById("loginView").style.display = "none"; document.getElementById("mainView").style.display = "block"; }).catch((e) => { toast("密码错误", "error"); TOKEN = ""; localStorage.removeItem("sk-free-admin-token"); });
}
function doLogout() { TOKEN = ""; localStorage.removeItem("sk-free-admin-token"); document.getElementById("loginView").style.display = "block"; document.getElementById("mainView").style.display = "none"; }
document.getElementById("tokenInput").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
let _loadSitesSeq = 0;
async function loadSites() {
  const seq = ++_loadSitesSeq;
  const q = document.getElementById("searchInput").value.trim();
  const tag = document.getElementById("tagFilter").value;
  const params = new URLSearchParams();
  params.set("page", SITE_PAGE);
  params.set("limit", SITE_LIMIT);
  if (q) params.set("q", q);
  if (tag) params.set("tag", tag);
  const data = await api("/api/admin/sites?" + params.toString());
  if (seq !== _loadSitesSeq) return;
  SITES = data.sites || [];
  document.getElementById("siteCount").textContent = (data.metadata?.total ?? SITES.length) + " 个站点";
  if (data.metadata) {
    renderPagination(data.metadata);
  }
  // 无搜索/标签过滤时刷新全量标签缓存，保证标签过滤选项完整
  if (!q && !tag && Array.isArray(data.sites)) {
    ALL_TAGS = [...new Set(SITES.flatMap((s) => s.tags || []))].sort();
  }
  buildTagFilter();
  renderTable();
}
async function loadDeadUrls() {
  try {
    const data = await api("/api/admin/dead-urls");
    DEAD_URLS = new Map((data.deadUrls || []).map((d) => [d.url, d]));
  } catch (e) {
    console.warn("加载死链库失败", e);
    DEAD_URLS = new Map();
  }
}
function buildTagFilter() {
  const tags = ALL_TAGS.length > 0 ? ALL_TAGS : [...new Set(SITES.flatMap((s) => s.tags || []))].sort();
  const sel = document.getElementById("tagFilter");
  const current = sel.value;
  sel.innerHTML = '<option value="">全部标签</option>' + tags.map((t) => '<option value="' + esc(t) + '">' + esc(t) + '</option>').join("");
  sel.value = current;
}
function renderTable() {
  const tbody = document.getElementById("sitesBody");
  if (SITES.length === 0) {
    tbody.innerHTML = '<tr><td colspan="11" class="empty-state">暂无数据</td></tr>';
    return;
  }
  tbody.innerHTML = SITES.map((s) => {
    const tags = (s.tags || []).map((t) => '<span class="tag">' + esc(t) + '</span>').join("");
    const checked = SELECTED.has(s.name) ? "checked" : "";
    const toggleChecked = s.enabled ? "checked" : "";
    const deadBadge = s.dead ? '<span class="badge badge-danger" title="已标记为死链（不可用）">死链</span>' : '';
    const knownDeadBadge = DEAD_URLS.has(s.url.replace(/[/]+$/, "")) ? '<span class="badge badge-warning" title="dead_urls 中有历史记录">已知死链</span>' : '';
    const origUrlHtml = s.originalUrl && s.originalUrl !== s.url ? '<span class="orig-url" title="' + esc(s.originalUrl) + '">原: ' + esc(s.originalUrl.slice(0, 40)) + (s.originalUrl.length > 40 ? '...' : '') + '</span>' : '';
    return '<tr>' +
      '<td class="w-check"><input type="checkbox" ' + checked + ' data-name="' + esc(s.name) + '" data-action="toggle-select"></td>' +
      '<td><label class="toggle"><input type="checkbox" ' + toggleChecked + ' data-name="' + esc(s.name) + '" data-action="toggle-enable"><span class="slider"></span></label></td>' +
      '<td class="name"><a href="' + esc(s.url) + '" target="_blank" title="' + esc(s.url) + '">' + esc(s.name) + '</a>' + deadBadge + knownDeadBadge + origUrlHtml + '</td>' +
      '<td class="health">' + healthBadge(s) + '</td>' +
      '<td class="tags">' + tags + '</td>' +
      '<td>' + esc(s.checkin || "") + '</td>' +
      '<td title="' + esc(s.ref || "") + '">' + esc(s.ref || "") + '</td>' +
      '<td>' + esc(s.models || "") + '</td>' +
      '<td>' + esc(s.rate || "") + '</td>' +
      '<td class="summary" title="' + esc(s.summary || "") + '">' + esc(s.summary || "") + '</td>' +
      '<td class="w-action actions"><button class="btn btn-sm" data-name="' + esc(s.name) + '" data-action="show-edit">编辑</button> <button class="btn btn-sm btn-danger" data-name="' + esc(s.name) + '" data-action="delete-site">删除</button></td>' +
    '</tr>';
  }).join("");
}
var _filterTimer = null;
function renderPagination(meta) {
  const el = document.getElementById("sitePagination");
  if (!el || !meta) return;
  const { total, page, limit, totalPages } = meta;
  if (totalPages <= 1) { el.innerHTML = ""; return; }
  const pages = [];
  const add = (p, label, active, disabled) => {
    pages.push('<button class="page-btn' + (active ? ' active' : '') + '" ' + (disabled ? 'disabled' : 'onclick="goToPage(' + p + ')"') + '>' + esc(label) + '</button>');
  };
  add(page - 1, "‹", false, page <= 1);
  let start = Math.max(1, page - 2);
  let end = Math.min(totalPages, page + 2);
  if (start > 1) { add(1, "1", false, false); if (start > 2) pages.push('<span class="page-ellipsis">...</span>'); }
  for (let i = start; i <= end; i++) add(i, String(i), i === page, false);
  if (end < totalPages) { if (end < totalPages - 1) pages.push('<span class="page-ellipsis">...</span>'); add(totalPages, String(totalPages), false, false); }
  add(page + 1, "›", false, page >= totalPages);
  el.innerHTML = '<div class="pagination">' + pages.join("") + '<span class="page-info">第 ' + page + '/' + totalPages + ' 页，共 ' + total + ' 条</span></div>';
}
function goToPage(p) {
  SITE_PAGE = p;
  window.scrollTo(0, 0);
  loadSites();
}
function filterTable() {
  SITE_PAGE = 1;
  loadSites();
}
function esc(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;"); }
// D1 的 datetime('now') 产出 "YYYY-MM-DD HH:MM:SS"，内容是 UTC 但字符串不带时区标记。
// 直接 new Date(它) 会被当成本地时间，UTC+8 下实测偏 8 小时；某些浏览器还会返回 Invalid Date。
// 传入毫秒时间戳（如 dead_urls.added_at）则原样使用。
function parseUtc(v) {
  if (v === null || v === undefined || v === "") return NaN;
  if (typeof v === "number") return v;
  var s = String(v).trim();
  if (/[Zz]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s)) return Date.parse(s);
  var m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/);
  if (m) return Date.parse(m[1] + "T" + m[2] + "Z");
  return Date.parse(s);
}
function fmtTime(v) { var t = parseUtc(v); return isNaN(t) ? "" : new Date(t).toLocaleString("zh-CN"); }
function toggleSelect(name, checked) { if (checked) SELECTED.add(name); else SELECTED.delete(name); updateBatchBar(); }
function toggleSelectAll() {
  const checked = document.getElementById("selectAll").checked;
  // 只操作选择框（data-action="toggle-select"），绝不触碰启用开关（toggle-enable）
  document.querySelectorAll('#sitesBody input[data-action="toggle-select"]').forEach((cb) => { 
    cb.checked = checked; 
    const name = cb.getAttribute("data-name"); 
    if (checked) SELECTED.add(name); else SELECTED.delete(name); 
  });
  updateBatchBar();
}
function clearSelection() { SELECTED.clear(); document.getElementById("selectAll").checked = false; document.querySelectorAll('#sitesBody input[data-action="toggle-select"]').forEach((cb) => cb.checked = false); updateBatchBar(); }
function updateBatchBar() { 
  const bar = document.getElementById("batchBar"); 
  const count = SELECTED.size; 
  document.getElementById("batchCount").textContent = count; 
  bar.classList.toggle("active", count > 0);
  // 同步全选框：当前页所有选择框都被选中时勾选，否则取消
  const boxes = document.querySelectorAll('#sitesBody input[data-action="toggle-select"]');
  const allChecked = boxes.length > 0 && [...boxes].every((cb) => cb.checked);
  document.getElementById("selectAll").checked = allChecked;
}
// 结构化字段的输入框 id ↔ API 字段名。新增/编辑/保存三处共用这一张表，
// 避免"表单加了框但保存漏了"或"保存发了但回填漏了"这种半截修改。
const STRUCT_FIELDS = [
  ["editQuotaTier", "quotaTier"],
  ["editQuotaMin", "quotaMin"],
  ["editQuotaMax", "quotaMax"],
  ["editQuotaUnit", "quotaUnit"],
  ["editQuotaPeriod", "quotaPeriod"],
  ["editQuotaCallsEst", "quotaCallsEst"],
  ["editQuotaRaw", "quotaRaw"],
  ["editKind", "kind"],
  ["editNeedsProxy", "needsProxy"],
  ["editSlug", "slug"]
];
const TEXT_FIELDS = ["editName","editUrl","editOriginalUrl","editTags","editSummary","editCheckin","editModels","editRate","editRegister","editRef","editNotes"];
function showCreate() {
  document.getElementById("editTitle").textContent = "新增站点";
  document.getElementById("editOriginalName").value = "";
  TEXT_FIELDS.concat(STRUCT_FIELDS.map((f) => f[0])).forEach((id) => { document.getElementById(id).value = ""; });
  _modalOpen();
  document.getElementById("editModal").classList.add("active");
  document.getElementById("editName").focus();
}
function showEdit(name) {
  const site = SITES.find((s) => s.name === name);
  if (!site) return;
  document.getElementById("editTitle").textContent = "编辑站点：" + name;
  document.getElementById("editOriginalName").value = name;
  document.getElementById("editName").value = site.name || "";
  document.getElementById("editUrl").value = site.url || "";
  document.getElementById("editOriginalUrl").value = site.originalUrl || "";
  document.getElementById("editTags").value = (site.tags || []).join(", ");
  document.getElementById("editSummary").value = site.summary || "";
  document.getElementById("editCheckin").value = site.checkin || "";
  document.getElementById("editModels").value = site.models || "";
  document.getElementById("editRate").value = site.rate || "";
  document.getElementById("editRegister").value = site.register || "";
  document.getElementById("editRef").value = site.ref || "";
  document.getElementById("editNotes").value = (site.notes || []).join("\n");
  STRUCT_FIELDS.forEach(function (f) {
    const v = site[f[1]];
    document.getElementById(f[0]).value = v === null || v === undefined ? "" : String(v);
  });
  _modalOpen();
  document.getElementById("editModal").classList.add("active");
}
function closeModal() { document.getElementById("editModal").classList.remove("active"); _modalClose(); }
async function saveSite() {
  const originalName = document.getElementById("editOriginalName").value;
  const tags = document.getElementById("editTags").value.split(",").map((t) => t.trim()).filter(Boolean);
  const notes = document.getElementById("editNotes").value.split("\n").map((t) => t.trim()).filter(Boolean);
  // 空值必须发 "" 而不是 undefined。
  // JSON.stringify 会把 undefined 的键整个丢掉，而后端更新用的是
  //   checkin: body.checkin ?? existing.checkin
  // 「键不存在」被解读为「不修改」—— 于是管理员把某个字段清空后点保存，
  // 接口返回 ok、toast 显示"更新成功"，但刷新回来旧值还在，清不掉。
  // 本地 wrangler dev + D1 实测过：清空 签到/模型/倍率/注册要求/备注 再保存，
  // 五个字段一个都没变。发 "" 后端才会真的写空（?? 只在 null/undefined 时兜底）。
  const val = (id) => document.getElementById(id).value.trim();
  const body = {
    name: val("editName"),
    url: val("editUrl"),
    originalUrl: val("editOriginalUrl"),
    tags,
    summary: val("editSummary"),
    checkin: val("editCheckin"),
    models: val("editModels"),
    rate: val("editRate"),
    register: val("editRegister"),
    ref: val("editRef"),
    notes,
  };
  // 结构化字段：空 = 显式 null（把字段改回"未知"），后端用 pick() 按键
  // 是否存在判断，所以这里必须把键都带上，null 才能真的写进去。
  // 数值字段要转成 number；空串转 null 而不是 0 —— 0 是有效额度，不能与未知混。
  const NUMERIC = { quotaMin: 1, quotaMax: 1, quotaCallsEst: 1, needsProxy: 1 };
  for (const f of STRUCT_FIELDS) {
    const raw = val(f[0]);
    if (raw === "") { body[f[1]] = null; continue; }
    if (NUMERIC[f[1]]) {
      const n = Number(raw);
      if (!Number.isFinite(n)) { toast(f[1] + " 必须是数字", "error"); return; }
      body[f[1]] = n;
    } else {
      body[f[1]] = raw;
    }
  }
  if (!body.name || !body.url) { toast("名称和 URL 为必填项", "error"); return; }
  // 额度区间的方向性：上限小于下限一定是填错了，让它在提交前就被挡住，
  // 否则前端会显示成 "25-5 刀/天" 这种读不通的区间。
  if (body.quotaMin !== null && body.quotaMax !== null && body.quotaMax < body.quotaMin) {
    toast("额度上限不能小于下限", "error");
    return;
  }
  try {
    if (originalName) { await api("/api/admin/sites/" + encodeURIComponent(originalName), { method: "PUT", body: JSON.stringify(body) }); toast("更新成功", "success"); }
    else { await api("/api/admin/sites", { method: "POST", body: JSON.stringify(body) }); toast("创建成功", "success"); }
    closeModal(); await loadSites();
  } catch (e) { toast(e.message, "error"); }
}
async function deleteSite(name) {
  var site = SITES.find(function(s) { return s.name === name; });
  var deadInfo = site && site.url ? DEAD_URLS.get(site.url.replace(/[/]+$/, "")) : null;
  var extra = "";
  if (deadInfo) {
    extra += '<label style="display:flex;align-items:center;gap:var(--space-2);padding:var(--space-3);background:var(--amber-soft);border-radius:var(--radius);border:1px solid var(--amber);cursor:pointer;transition:background var(--transition-fast)"><input type="checkbox" id="deleteDeadCheck" checked><span style="font-weight:600;color:var(--amber)">此 URL 在 dead_urls 中有记录</span></label>';
    extra += '<div class="text-sm text-muted" style="margin-top:var(--space-2);padding:var(--space-2) var(--space-3);background:var(--surface);border-radius:var(--radius);line-height:1.5">added_at: ' + fmtTime(deadInfo.added_at) + '<br>reason: ' + esc(deadInfo.reason) + '</div>';
  }
  var ok = await showConfirm("确认删除", '<p>站点：<strong>' + esc(name) + '</strong></p>' + (site ? '<p class="text-sm text-muted">URL：' + esc(site.url) + '</p>' : '') + (deadInfo ? '<p class="text-amber text-sm" style="margin-top:var(--space-2)">⚠️ 删除后 dead_urls 将追加 " | site-deleted" 痕迹</p>' : ''), extra, "删除");
  if (!ok) return;
  var addDead = deadInfo && document.getElementById("deleteDeadCheck").checked;
  try {
    await api("/api/admin/sites/" + encodeURIComponent(name), { method: "DELETE" });
    toast("已删除" + (addDead ? "（死链已追加记录）" : ""), "success");
    SELECTED.delete(name);
    await loadSites();
  } catch (e) { toast(e.message, "error"); }
}
async function batchDelete() {
  if (SELECTED.size === 0) return;
  var selectedSites = SITES.filter(function(s) { return SELECTED.has(s.name); });
  var hasDead = selectedSites.some(function(s) { return DEAD_URLS.has(s.url.replace(/[/]+$/, "")); });
  var ok = await showConfirm("确认批量删除", "<p>将删除 <strong>" + SELECTED.size + "</strong> 个站点</p>" + (hasDead ? '<p class="text-sm" style="color:var(--amber)">⚠️ 其中包含已知死链，删除后 dead_urls 将追加痕迹</p>' : ''), "", "批量删除");
  if (!ok) return;
  var btns = document.querySelectorAll('#batchBar .btn');
  btns.forEach(function(b) { btnLoading(b, true); });
  try { await api("/api/admin/sites/batch", { method: "POST", body: JSON.stringify({ action: "delete", names: [...SELECTED] }) }); toast("批量删除完成", "success"); SELECTED.clear(); updateBatchBar(); await loadSites(); renderTable(); } catch (e) { toast(e.message, "error"); } finally { btns.forEach(function(b) { btnLoading(b, false); }); }
}
async function batchDeleteDisabled() {
  var disabled = SITES.filter(function(s) { return !s.enabled; });
  if (disabled.length === 0) { toast("当前没有停用的站点", "info"); return; }
  var hasDead = disabled.some(function(s) { return DEAD_URLS.has(s.url.replace(/[/]+$/, "")); });
  var ok = await showConfirm("确认删除停用站点", "<p>将删除 <strong>" + disabled.length + "</strong> 个停用站点</p>" + (hasDead ? '<p class="text-sm" style="color:var(--amber)">⚠️ 其中包含已知死链，删除后 dead_urls 将追加痕迹</p>' : ''), "", "删除停用站点");
  if (!ok) return;
  var btns = document.querySelectorAll('#batchBar .btn');
  btns.forEach(function(b) { btnLoading(b, true); });
  try {
    var names = disabled.map(function(s) { return s.name; });
    var totalAffected = 0;
    for (var i = 0; i < names.length; i += 99) {
      var batch = names.slice(i, i + 99);
      var data = await api("/api/admin/sites/batch", { method: "POST", body: JSON.stringify({ action: "delete", names: batch }) });
      totalAffected += data.affected || 0;
    }
    toast("已删除 " + totalAffected + " 个停用站点", "success");
    SELECTED.clear(); updateBatchBar(); await loadSites(); renderTable();
  } catch (e) { toast(e.message, "error"); } finally { btns.forEach(function(b) { btnLoading(b, false); }); }
}
async function batchTag() {
  if (SELECTED.size === 0) return;
  var input = document.getElementById("batchTagInput");
  var tag = input.value.trim();
  if (!tag) { toast("请输入标签名称", "error"); input.focus(); return; }
  try { const data = await api("/api/admin/sites/batch", { method: "POST", body: JSON.stringify({ action: "add_tag", names: [...SELECTED], tag: tag }) }); toast("已为 " + data.affected + " 个站点添加标签", "success"); SELECTED.clear(); updateBatchBar(); input.value = ""; await loadSites(); renderTable(); } catch (e) { toast(e.message, "error"); }
}
async function toggleEnable(name, enabled) {
  try { const site = SITES.find((s) => s.name === name); if (!site) return; await api("/api/admin/sites/" + encodeURIComponent(name), { method: "PUT", body: JSON.stringify({ ...site, enabled }) }); toast(enabled ? "已启用：" + name : "已停用：" + name, "success"); if (!enabled && site.url) { try { await api("/api/admin/dead-urls", { method: "POST", body: JSON.stringify({ url: site.url, action: "add", reason: "manual-marked" }) }); } catch (e) { console.warn("写入 dead_urls 失败", e); } } await loadSites(); await loadDeadUrls(); renderTable(); } catch (e) { toast(e.message, "error"); }
}
async function batchEnable() {
  if (SELECTED.size === 0) return;
  var btns = document.querySelectorAll('#batchBar .btn');
  btns.forEach(function(b) { btnLoading(b, true); });
  try { const data = await api("/api/admin/sites/batch", { method: "POST", body: JSON.stringify({ action: "enable", names: [...SELECTED] }) }); toast("已启用 " + data.affected + " 个站点", "success"); SELECTED.clear(); updateBatchBar(); await loadSites(); renderTable(); } catch (e) { toast(e.message, "error"); } finally { btns.forEach(function(b) { btnLoading(b, false); }); }
}
async function batchDisable() {
  if (SELECTED.size === 0) return;
  var ok = await showConfirm("确认批量停用", "<p>将停用 <strong>" + SELECTED.size + "</strong> 个站点</p><p class='text-sm text-muted'>站点将不再在公开页展示</p>", "", "停用");
  if (!ok) return;
  var btns = document.querySelectorAll('#batchBar .btn');
  btns.forEach(function(b) { btnLoading(b, true); });
  try { 
    await api("/api/admin/sites/batch", { method: "POST", body: JSON.stringify({ action: "disable", names: [...SELECTED] }) }); 
    var selectedForDead = SITES.filter(function(s) { return SELECTED.has(s.name); });
    var deadUrls = selectedForDead.map(function(s) { return s.url; }).filter(Boolean);
    if (deadUrls.length > 0) {
      try { await api("/api/admin/dead-urls/batch", { method: "POST", body: JSON.stringify({ urls: deadUrls, action: "add" }) }); } catch (e) { console.warn("批量写入 dead_urls 失败", e); }
    }
    toast("已停用 " + SELECTED.size + " 个站点", "success"); 
    SELECTED.clear(); updateBatchBar(); 
    await loadSites(); await loadDeadUrls(); renderTable();
  } catch (e) { toast(e.message, "error"); } finally { btns.forEach(function(b) { btnLoading(b, false); }); }
}
// 对选中的站点重新做健康检查（只查选中的，不查全部）
async function batchRecheck() {
  if (SELECTED.size === 0) { toast("请先选择要复查的站点", "info"); return; }
  var selectedSites = SITES.filter(function(s) { return SELECTED.has(s.name); });
  var urls = selectedSites.map(function(s) { return s.url; }).filter(Boolean);
  if (urls.length === 0) { toast("选中的站点没有可检查的 URL", "error"); return; }
  var statusEl = document.getElementById("sitesCleanStatus");
  statusEl.textContent = "正在复查 " + urls.length + " 个站点...";
  try {
    var data = await api("/api/admin/check-batch", { method: "POST", body: JSON.stringify({ urls: urls }) });
    var alive = data.results.filter(function(r) { return r.ok; }).length;
    var dead = data.results.filter(function(r) { return !r.ok; }).length;
    statusEl.textContent = "复查完成：" + alive + " 可达，" + dead + " 不可达";
    toast("复查完成：" + alive + " 可达，" + dead + " 不可达", dead > 0 ? "info" : "success");
    // 更新健康 tab 数据
    await loadSites(); renderTable(); renderHealthFromSites();
  } catch (e) { statusEl.textContent = "复查失败: " + e.message; toast("复查失败: " + e.message, "error"); }
}
function switchTab(tab) {
  // 用 data-tab 属性匹配，不依赖 DOM 顺序
  document.querySelectorAll(".tab-btn").forEach(btn => { btn.classList.toggle("active", btn.dataset.tab === tab); });
  document.getElementById("panelSites").classList.toggle("active", tab === "sites");
  document.getElementById("panelSubmissions").classList.toggle("active", tab === "submissions");
  document.getElementById("panelHealth").classList.toggle("active", tab === "health");
  document.getElementById("panelFeedback").classList.toggle("active", tab === "feedback");
  document.getElementById("panelSchema").classList.toggle("active", tab === "schema");
  if (tab === "submissions") loadSubmissions();
  if (tab === "feedback") loadFeedbacks();
  if (tab === "schema") loadSchema();
  // 健康 tab：从数据库已有数据构建对账报告，无需扫描
  if (tab === "health") renderHealthFromSites();
}
async function loadSubmissions() {
  try {
    const data = await api("/api/admin/submissions");
    const list = document.getElementById("submissionsList");
    const countEl = document.getElementById("subCount");
    if (!data.submissions || data.submissions.length === 0) { list.innerHTML = '<div class="sub-empty">暂无待审核提交</div>'; countEl.style.display = "none"; return; }
    countEl.textContent = data.submissions.length; countEl.style.display = "inline";
    list.innerHTML = data.submissions.map((sub) => {
      const time = fmtTime(sub.createdAt);
      const tags = (sub.site.tags || []).map((t) => '<span class="tag">' + esc(t) + '</span>').join(" ");
      return '<div class="sub-card" id="sub-' + sub.id + '"><div class="sub-header"><span class="sub-name">' + esc(sub.site.name) + '</span><span class="sub-time">' + esc(time) + ' | ' + esc(sub.ip) + '</span></div><div class="sub-url">' + esc(sub.site.url) + '</div>' + (sub.site.summary ? '<div class="sub-summary">' + esc(sub.site.summary) + '</div>' : '') + (tags ? '<div class="mt-1">' + tags + '</div>' : '') + '<div class="sub-actions"><button class="btn btn-sm btn-primary" data-id="' + esc(sub.id) + '" data-action="approve-submission">✅ 批准</button> <button class="btn btn-sm btn-danger" data-id="' + esc(sub.id) + '" data-action="reject-submission">❌ 驳回</button></div></div>';
    }).join("");
  } catch (e) { toast(e.message, "error"); }
}
async function approveSubmission(id) {
  // M6：改单次原子请求（建站 + 标记批准在服务端同一 batch 完成）。
  // 原来先 POST /api/admin/sites 再标记批准，两步之间失败会留下
  // "站点已建但提交仍 pending"的半完成状态，重试还会 409 卡死。
  // 注意：这里不能写反引号模板字符串或美元花括号插值——本段 JS 本身嵌在
  // getAdminHTML() 的模板字面量里，反引号会提前终止外层模板、插值会被
  // 服务端求值。必须用字符串拼接。
  try {
    await api("/api/admin/submissions/" + encodeURIComponent(id) + "/approve", { method: "POST" });
    toast("已批准并添加站点", "success"); await loadSubmissions(); await loadSites();
  } catch (e) { toast(e.message, "error"); }
}
async function rejectSubmission(id) {
  var ok = await showConfirm("确认驳回", "<p>驳回后将无法恢复，确认驳回此提交？</p>", "", "驳回");
  if (!ok) return;
  try { await api("/api/admin/sites/batch", { method: "POST", body: JSON.stringify({ action: "reject_submission", id }) }); toast("已驳回", "success"); await loadSubmissions(); } catch (e) { toast(e.message, "error"); }
}
// 恢复死链 = 启用站点（走 /api/admin/sites/batch 的 enable，写人工验证时间）
// 这是"可用/死链"二元模型的唯一状态入口：健康扫描对账报告里的
// "标记为死链"/"恢复为可用"按钮都走这里，站点表的"启用"开关也走这里。
async function setDeadByName(name, isDead) {
  try {
    const data = await api("/api/admin/sites/batch", { method: "POST", body: JSON.stringify({ action: isDead ? "disable" : "enable", names: [name] }) });
    toast(isDead ? "已标记为死链：" + name : "已恢复为可用：" + name, "success");
    if (isDead) {
      const site = SITES.find((s) => s.name === name);
      if (site && site.url) {
        try { await api("/api/admin/dead-urls", { method: "POST", body: JSON.stringify({ url: site.url, action: "add", reason: "manual-marked" }) }); } catch {}
      }
    }
    await loadSites(); await loadDeadUrls(); renderHealthFromSites();
  } catch (e) { toast(e.message, "error"); }
}
// 站点健康状态徽章（基于数据库已有数据，无需扫描）
function healthBadge(s) {
  if (s.dead) return '<span class="badge badge-danger text-xs">\u2716 已停用</span>';
  if (s.healthFailCount > 2) return '<span class="badge badge-danger text-xs">\u26a0 连续失败 ' + s.healthFailCount + ' 次</span>';
  if (s.verifiedAt) {
    var ts = parseUtc(s.verifiedAt);
    var diff = Date.now() - ts;
    if (diff < 86400000) return '<span class="badge badge-success text-xs">\u2714 24h内验证</span>';
    if (diff < 604800000) return '<span class="badge badge-warning text-xs">\u25cf 7天内验证</span>';
    return '<span class="badge badge-neutral text-xs">\u25cb 超7天未验证</span>';
  }
  return '<span class="badge badge-neutral text-xs">\u25cb 未验证</span>';
}
// 从数据库已有数据构建健康对账报告（无需扫描）
// 包含批量操作：死链可批量恢复，异常可批量标记
var HEALTH_DEAD_SELECTED = new Set();
var HEALTH_FAIL_SELECTED = new Set();
function renderHealthFromSites() {
  var statusEl = document.getElementById("healthStatus");
  var resultsEl = document.getElementById("healthResults");
  if (!SITES || SITES.length === 0) { statusEl.textContent = "请先加载站点列表"; return; }
  // 从数据库数据派生对账报告
  var unreachEnabled = SITES.filter(function(s) { return s.dead; });
  var reachWithFails = SITES.filter(function(s) { return !s.dead && s.healthFailCount > 0; });
  var reachVerified = SITES.filter(function(s) { return !s.dead && s.healthFailCount === 0 && s.verifiedAt; });
  var reachUnverified = SITES.filter(function(s) { return !s.dead && s.healthFailCount === 0 && !s.verifiedAt; });
  var html = "";
  // 通用表格样式
  var tblClass = 'class="table"';
  var thClass = 'class="text-sm text-muted font-semibold"';
  var tdClass = 'class="text-sm"';
  // ── 死链表 ────────────────────────────────────────────────────────────
  if (unreachEnabled.length > 0) {
    html += '<div class="section-header">';
    html += '<strong class="title text-coral">\u2716 已标记为死链（' + unreachEnabled.length + '）</strong>';
    html += '<button class="btn btn-sm btn-primary" data-action="healthBatchRestoreDead">\u2705 恢复选中</button>';
    html += '<button class="btn btn-sm" data-action="healthBatchRecheckDead">\u200d\u200d🔍 重新复查选中</button>';
    html += '<button class="btn btn-sm btn-danger" data-action="healthRestoreAllDead">\u2705 恢复全部</button>';
    html += '<button class="btn btn-sm" data-action="healthClearDeadSelection">\u2716 取消选择</button>';
    html += '<span id="healthDeadCount" class="count text-muted text-sm">已选 0 个</span>';
    html += '</div>';
    html += '<table class="table health-dead-table"><thead><tr>';
    html += '<th class="w-check"><input type="checkbox" id="healthDeadSelectAll" data-action="healthToggleDeadSelectAll"></th>';
    html += '<th ' + thClass + '>站点名称</th>';
    html += '<th ' + thClass + '>验证时间</th>';
    html += '<th ' + thClass + ' class="w-action">操作</th>';
    html += '</tr></thead><tbody>';
    html += unreachEnabled.map(function(s) {
      return '<tr>' +
        '<td class="w-check"><input type="checkbox" data-name="' + esc(s.name) + '" data-action="healthToggleDeadSelect"></td>' +
        '<td ' + tdClass + '><a href="' + esc(s.url) + '" target="_blank">' + esc(s.name) + '</a></td>' +
        '<td ' + tdClass + ' class="text-muted text-sm">' + (s.verifiedAt ? "\u2705 " + fmtTime(s.verifiedAt) : '\u25cb 未验证') + '</td>' +
        '<td ' + tdClass + ' class="w-action">' +
        '<button class="btn btn-sm btn-primary" data-name="' + esc(s.name) + '" data-action="restore-dead">\u6062\u590d\u4e3a\u53ef\u7528</button>' +
        '<button class="btn btn-sm" data-name="' + esc(s.name) + '" data-action="recheck-dead">\u200d\u200d🔍 复查</button></td>' +
        '</tr>';
    }).join("");
    html += '</tbody></table>';
  }
  // ── 异常表：可批量标记死链 ────────────────────────────────────────────
  if (reachWithFails.length > 0) {
    html += '<div class="section-header" style="margin:var(--space-3) 0 var(--space-2)">';
    html += '<strong class="title text-coral">\u26a0 可用但连续失败（' + reachWithFails.length + '）</strong>';
    html += '<button class="btn btn-sm btn-danger" data-action="healthBatchMarkDead">\u2716 标记选中为死链</button>';
    html += '<button class="btn btn-sm" data-action="healthClearFailSelection">\u2716 取消选择</button>';
    html += '<span id="healthFailCount" class="count text-muted text-sm">已选 0 个</span>';
    html += '</div>';
    html += '<table class="table health-fail-table"><thead><tr>';
    html += '<th class="w-check"><input type="checkbox" id="healthFailSelectAll" data-action="healthToggleFailSelectAll"></th>';
    html += '<th ' + thClass + '>站点名称</th>';
    html += '<th ' + thClass + '>失败次数</th>';
    html += '<th ' + thClass + ' class="w-action">操作</th>';
    html += '</tr></thead><tbody>';
    html += reachWithFails.map(function(s) {
      return '<tr>' +
        '<td class="w-check"><input type="checkbox" data-name="' + esc(s.name) + '" data-action="healthToggleFailSelect"></td>' +
        '<td ' + tdClass + '><a href="' + esc(s.url) + '" target="_blank">' + esc(s.name) + '</a></td>' +
        '<td ' + tdClass + ' class="text-coral text-sm">\u26a0 ' + s.healthFailCount + ' 次</td>' +
        '<td ' + tdClass + ' class="w-action"><button class="btn btn-sm btn-danger" data-name="' + esc(s.name) + '" data-action="mark-dead">\u6807\u8bb0\u4e3a\u6b7b\u94fe</button></td>' +
        '</tr>';
    }).join("");
    html += '</tbody></table>';
  }
  // ── 正常区 ────────────────────────────────────────────────────────────
  html += '<div class="text-muted text-sm" style="margin:var(--space-3) 0 var(--space-1)">\u2705 正常：' + (reachVerified.length + reachUnverified.length) + '（已验证 ' + reachVerified.length + '，未验证 ' + reachUnverified.length + '）。</div>';
  resultsEl.innerHTML = html;
  statusEl.textContent = "基于数据库最近一次 cron 检查结果（每 6 小时自动更新）。需要最新数据请点【批量检查】。";
}
// 死链区的批量选择
function healthToggleDeadSelect(cb) {
  if (cb.checked) HEALTH_DEAD_SELECTED.add(cb.getAttribute("data-name"));
  else HEALTH_DEAD_SELECTED.delete(cb.getAttribute("data-name"));
  document.getElementById("healthDeadCount").textContent = "已选 " + HEALTH_DEAD_SELECTED.size + " 个";
  document.getElementById("healthDeadSelectAll").checked = HEALTH_DEAD_SELECTED.size === SITES.filter(function(s) { return s.dead; }).length;
}
function healthToggleDeadSelectAll(cb) {
  document.querySelectorAll('#healthResults .health-dead-table tbody input[type="checkbox"]').forEach(function(el) {
    el.checked = cb.checked;
    var name = el.getAttribute("data-name");
    if (cb.checked) HEALTH_DEAD_SELECTED.add(name); else HEALTH_DEAD_SELECTED.delete(name);
  });
  document.getElementById("healthDeadCount").textContent = "已选 " + HEALTH_DEAD_SELECTED.size + " 个";
}
function healthClearDeadSelection() {
  HEALTH_DEAD_SELECTED.clear();
  document.getElementById("healthDeadSelectAll").checked = false;
  document.querySelectorAll('#healthResults .health-dead-table tbody input[type="checkbox"]').forEach(function(el) { el.checked = false; });
  document.getElementById("healthDeadCount").textContent = "已选 0 个";
}
async function healthBatchRecheckDead() {
  if (HEALTH_DEAD_SELECTED.size === 0) { toast("请先选择要复查的站点", "info"); return; }
  var urls = SITES.filter(function(s) { return HEALTH_DEAD_SELECTED.has(s.name); }).map(function(s) { return s.url; }).filter(Boolean);
  if (urls.length === 0) { toast("选中的站点没有可检查的 URL", "error"); return; }
  try { var data = await api("/api/admin/check-batch", { method: "POST", body: JSON.stringify({ urls: urls }) }); var alive = data.results.filter(function(r) { return r.ok; }).length; var dead = data.results.filter(function(r) { return !r.ok; }).length; toast("复查完成：" + alive + " 可达，" + dead + " 不可达", dead > 0 ? "info" : "success"); await loadSites(); renderTable(); renderHealthFromSites(); } catch (e) { toast("复查失败: " + e.message, "error"); }
}
async function healthRecheckSingleDead(name) {
  var s = SITES.find(function(s) { return s.name === name; });
  if (!s || !s.url) { toast("站点无 URL", "error"); return; }
  try { var data = await api("/api/admin/check-batch", { method: "POST", body: JSON.stringify({ urls: [s.url] }) }); var r = data.results[0]; toast("\u200d\u200d🔍 " + name + "：" + (r.ok ? "可达" : "不可达"), r.ok ? "success" : "error"); await loadSites(); renderTable(); renderHealthFromSites(); } catch (e) { toast("复查失败: " + e.message, "error"); }
}
async function healthBatchRestoreDead() {
  if (HEALTH_DEAD_SELECTED.size === 0) { toast("请先选择要恢复的站点", "info"); return; }
  try { await api("/api/admin/sites/batch", { method: "POST", body: JSON.stringify({ action: "enable", names: [...HEALTH_DEAD_SELECTED] }) }); toast("已恢复 " + HEALTH_DEAD_SELECTED.size + " 个站点", "success"); HEALTH_DEAD_SELECTED.clear(); await loadSites(); renderTable(); renderHealthFromSites(); } catch (e) { toast(e.message, "error"); }
}
async function healthRestoreAllDead() {
  var names = SITES.filter(function(s) { return s.dead; }).map(function(s) { return s.name; });
  if (names.length === 0) { toast("没有死链站点", "info"); return; }
  var ok = await showConfirm("确认恢复全部", "<p>将恢复 <strong>" + names.length + "</strong> 个死链站点为可用</p>", "", "恢复全部");
  if (!ok) return;
  try {
    var totalAffected = 0;
    for (var i = 0; i < names.length; i += 99) {
      var batch = names.slice(i, i + 99);
      var data = await api("/api/admin/sites/batch", { method: "POST", body: JSON.stringify({ action: "enable", names: batch }) });
      totalAffected += data.affected || 0;
    }
    toast("已恢复 " + totalAffected + " 个站点", "success");
    HEALTH_DEAD_SELECTED.clear();
    await loadSites(); renderTable(); renderHealthFromSites();
  } catch (e) { toast(e.message, "error"); }
}
// 异常区的批量选择
function healthToggleFailSelect(cb) {
  if (cb.checked) HEALTH_FAIL_SELECTED.add(cb.getAttribute("data-name"));
  else HEALTH_FAIL_SELECTED.delete(cb.getAttribute("data-name"));
  document.getElementById("healthFailCount").textContent = "已选 " + HEALTH_FAIL_SELECTED.size + " 个";
  document.getElementById("healthFailSelectAll").checked = HEALTH_FAIL_SELECTED.size === SITES.filter(function(s) { return !s.dead && s.healthFailCount > 0; }).length;
}
function healthToggleFailSelectAll(cb) {
  document.querySelectorAll('#healthResults .health-fail-table tbody input[type="checkbox"]').forEach(function(el) {
    el.checked = cb.checked;
    var name = el.getAttribute("data-name");
    if (cb.checked) HEALTH_FAIL_SELECTED.add(name); else HEALTH_FAIL_SELECTED.delete(name);
  });
  document.getElementById("healthFailCount").textContent = "已选 " + HEALTH_FAIL_SELECTED.size + " 个";
}
function healthClearFailSelection() {
  HEALTH_FAIL_SELECTED.clear();
  document.getElementById("healthFailSelectAll").checked = false;
  document.querySelectorAll('#healthResults .health-fail-table tbody input[type="checkbox"]').forEach(function(el) { el.checked = false; });
  document.getElementById("healthFailCount").textContent = "已选 0 个";
}
async function healthBatchMarkDead() {
  if (HEALTH_FAIL_SELECTED.size === 0) { toast("请先选择要标记的站点", "info"); return; }
  var selectedSites = SITES.filter(function(s) { return HEALTH_FAIL_SELECTED.has(s.name); });
  var urls = selectedSites.map(function(s) { return s.url; }).filter(Boolean);
  try {
    await api("/api/admin/sites/batch", { method: "POST", body: JSON.stringify({ action: "disable", names: [...HEALTH_FAIL_SELECTED] }) });
    if (urls.length > 0) {
      try { await api("/api/admin/dead-urls/batch", { method: "POST", body: JSON.stringify({ urls: urls, action: "add" }) }); } catch (e) { console.warn("批量写入 dead_urls 失败", e); }
    }
    toast("已标记 " + HEALTH_FAIL_SELECTED.size + " 个站点为死链", "success");
    HEALTH_FAIL_SELECTED.clear();
    await loadSites(); await loadDeadUrls(); renderTable(); renderHealthFromSites();
  } catch (e) { toast(e.message, "error"); }
}
/**
 * 共享的健康扫描逻辑（链接健康 tab 和站点管理 tab 共用）
 * @param {object} opts
 * @param {function} opts.onProgress — 进度回调 (msg) => void
 * @param {function} opts.onResult — 扫描完成回调 ({ alive, dead, allResults }) => void
 */
async function runHealthScan({ onProgress, onResult }) {
  // 必须与 worker/src/health.js 的 HEALTH_BATCH_SIZE 一致。
  // 服务端会硬截断并在响应里回传 maxBatch，下面做漂移检测——
  // 万一两边不一致，宁可报出来也不要静默丢掉后半批 URL。
  let BATCH_SIZE = 20;
  const allUrls = SITES.map(s => s.url).filter(Boolean);
  if (allUrls.length === 0) { onProgress("没有可检查的站点"); return; }
  const allResults = [];
  let i = 0;
  let batchIdx = 0;
  while (i < allUrls.length) {
    batchIdx++;
    const totalBatches = Math.ceil(allUrls.length / BATCH_SIZE);
    onProgress("正在检查... 批次 " + batchIdx + "/" + totalBatches + "（" + Math.min(i + BATCH_SIZE, allUrls.length) + "/" + allUrls.length + "）");
    const data = await api("/api/admin/check-batch", { method: "POST", body: JSON.stringify({ urls: allUrls.slice(i, i + BATCH_SIZE) }) });
    allResults.push(...data.results);
    // 服务端截断了 = 前后端常量漂移，按服务端的上限收紧并继续
    if (data.maxBatch && data.maxBatch < BATCH_SIZE) {
      BATCH_SIZE = data.maxBatch;
      i += data.results.length;
    } else {
      i += BATCH_SIZE;
    }
  }
  const alive = allResults.filter(r => r.ok).length;
  const dead = allResults.filter(r => !r.ok).length;
  Promise.resolve(onResult({ alive, dead, allResults })).catch((e) => { console.warn("onResult 回调失败", e); });
}

async function batchCheckUrls() {
  const statusEl = document.getElementById("healthStatus"); const resultsEl = document.getElementById("healthResults");
  statusEl.textContent = "正在检查中，请稍候..."; resultsEl.innerHTML = "";
  try {
    await runHealthScan({
      onProgress: (msg) => { statusEl.textContent = msg; },
      onResult: ({ alive, dead, allResults }) => {
        statusEl.textContent = "扫描完成：共 " + allResults.length + " 个 URL，" + alive + " 可达，" + dead + " 不可达（仅记录证据，不自动改状态）";
        // 对账报告：扫描结果 × 站点当前可用性。
        // 交互模式与下方 renderHealthFromSites 一致：表格 + 全选 + 行选 + 批量按钮，
        // 且所有操作都是"原位更新"（移除已处理行），报告在清账完成前常驻不被覆盖。
        var byUrl = {};
        SITES.forEach(function(s) { byUrl[s.url] = s; });
        var unreachEnabled = [];  // 不可达 + 当前启用 → 建议标记死链
        var unreachDisabled = []; // 不可达 + 当前禁用 → 已在死链
        var reachDisabled = [];   // 可达 + 当前禁用 → 可能已恢复
        var reachEnabled = [];    // 可达 + 当前启用 → 正常
        allResults.forEach(function(r) {
          var s = byUrl[r.url];
          var isEnabled = s ? s.enabled !== false : true;
          if (r.ok) { if (isEnabled) reachEnabled.push(r); else reachDisabled.push(r); }
          else { if (isEnabled) unreachEnabled.push(r); else unreachDisabled.push(r); }
        });
        var tblClass = 'class="table"';
        var thClass = 'class="text-sm text-muted font-semibold"';
        var tdClass = 'class="text-sm"';
        function section(id, title, color, rows, batchBtn, evidence) {
          if (rows.length === 0) return "";
          var h = '<div id="' + id + 'Section">';
          h += '<div class="section-header">';
          h += '<strong class="title text-coral">' + title + '(' + rows.length + ')</strong>';
          h += batchBtn;
          h += '<span id="' + id + 'Count" class="count text-muted text-sm">已选 0 个</span>';
          h += '</div>';
          h += '<table class="table"><thead><tr>';
          h += '<th class="w-check"><input type="checkbox" data-scan-all="' + id + '" data-action="scanToggleAll"></th>';
          h += '<th class="text-sm text-muted font-semibold">站点名称</th>';
          h += '<th class="text-sm text-muted font-semibold">状态</th>';
          h += '<th class="text-sm text-muted font-semibold w-action">操作</th>';
          h += '</tr></thead><tbody id="' + id + 'Body">';
          h += rows.map(function(r) {
            var s = byUrl[r.url];
            return '<tr data-name="' + esc(s.name) + '">' +
              '<td class="w-check"><input type="checkbox" data-name="' + esc(s.name) + '" data-body="' + id + 'Body" data-action="scanCkChanged"></td>' +
              '<td ' + tdClass + '><a href="' + esc(r.url) + '" target="_blank">' + esc(s.name) + '</a> <span class="text-muted text-xs">' + esc(r.url) + '</span></td>' +
              '<td class="text-sm" style="white-space:nowrap;color:' + color + '">' + evidence(r) + '</td>' +
              '<td ' + tdClass + ' class="w-action">' +
              '<button class="btn btn-sm ' + (id === "scanMark" ? "btn-danger" : "btn-primary") + '" data-action="scanOne" data-mark="' + (id === "scanMark" ? "true" : "false") + '">' + (id === "scanMark" ? "\u6807\u8bb0\u4e3a\u6b7b\u94fe" : "\u6062\u590d\u4e3a\u53ef\u7528") + '</button></td>' +
              '</tr>';
          }).join("");
          h += '</tbody></table></div>';
          return h;
        }
        var html = "";
        html += section("scanMark", "\u26a1 \u4e0d\u53ef\u8fbe\u4f46\u5f53\u524d\u53ef\u7528\uff08\u5efa\u8bae\u6807\u8bb0\u4e3a\u6b7b\u94fe\uff09", "var(--coral)", unreachEnabled,
          '<button class="btn btn-sm btn-danger" data-action="scanBatchMark">\u2716 \u6807\u8bb0\u9009\u4e2d\u4e3a\u6b7b\u94fe</button>',
          function(r) { return esc(r.error || ("HTTP " + r.status)); });
        html += section("scanRestore", "\ud83d\udd04 \u5df2\u53ef\u8fbe\u4f46\u5f53\u524d\u4e3a\u6b7b\u94fe\uff08\u5efa\u8bae\u6062\u590d\u4e3a\u53ef\u7528\uff09", "var(--teal)", reachDisabled,
          '<button class="btn btn-sm btn-primary" data-action="scanBatchRestore">\u2714 \u6062\u590d\u9009\u4e2d\u4e3a\u53ef\u7528</button>',
          function(r) { return "HTTP " + r.status; });
        html += '<div class="text-muted text-sm" style="margin:var(--space-3) 0 var(--space-1)">\u5df2\u4e00\u81f4\uff08\u65e0\u9700\u64cd\u4f5c\uff09\uff1a\u4e0d\u53ef\u8fbe\u4e14\u5df2\u6807\u8bb0\u6b7b\u94fe ' + unreachDisabled.length + ' \u4e2a\uff1b\u53ef\u8fbe\u4e14\u53ef\u7528 ' + reachEnabled.length + ' \u4e2a\u3002\u52fe\u9009\u540e\u70b9\u6279\u91cf\u6309\u94ae\uff0c\u5904\u7406\u8fc7\u7684\u884c\u4f1a\u4ece\u5217\u8868\u79fb\u9664\u3002</div>';
        // 静默刷新 SITES（站点表开关/徽章保持最新）；绝不调 renderHealthFromSites，
        // 否则 DB 状态视图会立刻覆盖掉刚生成的扫描对账报告
        resultsEl.innerHTML = html; loadSites();
      },
    });
  } catch (e) { statusEl.textContent = "检查失败: " + e.message; }
}
// ── 扫描对账报告的原位操作 ────────────────────────────────────────────────
// 与 DB 视图（HEALTH_*_SELECTED 那套）刻意分开：这里不用全局选择集，
// 直接以 DOM 勾选状态为准，天然避免"报告重渲染后残留旧选中"的脏状态。
function scanCheckedNames(bodyId) {
  // 注意：bodyId 指向的就是 <tbody> 本身，不要再往里找一层 tbody
  return Array.prototype.map.call(
    document.querySelectorAll("#" + bodyId + " input[type=checkbox]:checked"),
    function(cb) { return cb.getAttribute("data-name"); }
  );
}
function scanCountEl(bodyId) {
  return document.getElementById(bodyId === "scanMarkBody" ? "scanMarkCount" : "scanRestoreCount");
}
function scanSectionId(bodyId) { return bodyId === "scanMarkBody" ? "scanMarkSection" : "scanRestoreSection"; }
function scanUpdateCount(bodyId) {
  var el = scanCountEl(bodyId);
  if (el) el.textContent = "已选 " + scanCheckedNames(bodyId).length + " 个";
  var all = document.querySelector("#" + scanSectionId(bodyId) + " input[data-scan-all]");
  if (all) {
    var boxes = document.querySelectorAll("#" + bodyId + " input[type=checkbox]");
    all.checked = boxes.length > 0 && boxes.length === scanCheckedNames(bodyId).length;
  }
}
function scanCkChanged(cb) { scanUpdateCount(cb.getAttribute("data-body")); }
function scanToggleAll(cb) {
  var bodyId = cb.getAttribute("data-scan-all") + "Body";
  document.querySelectorAll("#" + bodyId + " input[type=checkbox]").forEach(function(b) { b.checked = cb.checked; });
  scanUpdateCount(bodyId);
}
// 从报告中移除已处理的行；组空则整节替换为完成提示
function scanRemoveRows(bodyId, names) {
  var done = new Set(names);
  var body = document.getElementById(bodyId);
  if (!body) return;
  Array.prototype.slice.call(body.querySelectorAll("tr")).forEach(function(tr) {
    if (done.has(tr.getAttribute("data-name"))) tr.remove();
  });
  var section = document.getElementById(scanSectionId(bodyId));
  if (section && body.querySelectorAll("tr").length === 0) {
    section.innerHTML = '<div class="text-muted text-sm" style="margin:var(--space-3) 0">\u2714 \u672c\u7ec4\u5df2\u5168\u90e8\u5904\u7406\u5b8c\u6bd5</div>';
  } else {
    scanUpdateCount(bodyId);
  }
}
// 核心：调批量接口 + 原位移除 + 静默刷新（绝不重渲染整个视图）
async function scanApply(names, action, bodyId) {
  if (!names || names.length === 0) { toast("请先勾选站点", "info"); return; }
  if (action === "disable") {
    var ok = await showConfirm("确认标记为死链", "<p>将标记 <strong>" + names.length + "</strong> 个站点为死链</p><p style='font-size:12px;color:var(--muted)'>站点将不再在公开页展示</p>", "", "标记为死链");
    if (!ok) return;
  }
  try {
    var data = await api("/api/admin/sites/batch", { method: "POST", body: JSON.stringify({ action: action, names: names }) });
    toast((action === "disable" ? "已标记 " : "已恢复 ") + data.affected + " 个站点", "success");
    scanRemoveRows(bodyId, names);
    if (action === "disable") {
      var scanSites = SITES.filter(function(s) { return names.indexOf(s.name) !== -1; });
      var scanUrls = scanSites.map(function(s) { return s.url; }).filter(Boolean);
      if (scanUrls.length > 0) {
        try { await api("/api/admin/dead-urls/batch", { method: "POST", body: JSON.stringify({ urls: scanUrls, action: "add" }) }); } catch (e) { console.warn("扫描批量写入 dead_urls 失败", e); }
      }
    }
    await loadSites(); await loadDeadUrls();
  } catch (e) { toast(e.message, "error"); }
}
function scanBatchMark() { scanApply(scanCheckedNames("scanMarkBody"), "disable", "scanMarkBody"); }
function scanBatchRestore() { scanApply(scanCheckedNames("scanRestoreBody"), "enable", "scanRestoreBody"); }
function scanOne(btn, isDead) {
  var tr = btn.closest("tr");
  if (!tr) return;
  var name = tr.getAttribute("data-name");
  scanApply([name], isDead ? "disable" : "enable", tr.parentElement.id);
}
// ── 站点管理 tab 一键清理死链 ──────────────────────────────────────────────
async function sitesCleanupDeadLinks() {
  var statusEl = document.getElementById("sitesCleanStatus");
  if (SITES.length === 0) { toast("请先加载站点列表", "error"); return; }
  var ok = await showConfirm("确认扫描", "<p>将检查全部 <strong>" + SITES.length + "</strong> 个站点的 URL 可达性</p><p class='text-sm text-muted'>结果支持一键标记/恢复</p>", "", "开始扫描");
  if (!ok) return;
  statusEl.textContent = "正在检查中...";
  try {
    await runHealthScan({
      onProgress: (msg) => { statusEl.textContent = msg; },
      onResult: ({ alive, dead, allResults }) => {
        var byUrl = {};
        SITES.forEach(function(s) { byUrl[s.url] = s; });
        var unreachEnabled = [], reachDisabled = [];
        allResults.forEach(function(r) {
          var s = byUrl[r.url];
          var isEnabled = s ? s.enabled !== false : true;
          if (r.ok) { if (!isEnabled) reachDisabled.push(r); }
          else { if (isEnabled) unreachEnabled.push(r); }
        });
        // 构建与 batchCheckUrls 一致的对账报告，存入缓存供健康 tab 查看
        var html = "";
        if (unreachEnabled.length > 0) {
          html += '<div style="margin-bottom:var(--space-2)"><strong style="color:var(--coral)">\u26a1 \u4e0d\u53ef\u8fbe\u4f46\u5f53\u524d\u53ef\u7528\uff08\u5efa\u8bae\u6807\u8bb0\u4e3a\u6b7b\u94fe\uff09(' + unreachEnabled.length + ')</strong></div>';
          html += unreachEnabled.map(function(r) {
            var s = byUrl[r.url];
            return '<div class="section-header" style="padding:var(--space-1) 0;font-size:12px;border-bottom:1px solid var(--line)">' +
              '<span style="flex:1;word-break:break-all"><a href="' + esc(r.url) + '" target="_blank">' + esc(s.name) + '</a> <span style="color:var(--muted)">' + esc(r.url) + '</span></span>' +
              '<span style="color:var(--coral);white-space:nowrap">' + esc(r.error || ("HTTP " + r.status)) + '</span>' +
              '<button class="btn btn-sm btn-danger" data-name="' + esc(s.name) + '" data-action="mark-dead">\u6807\u8bb0\u4e3a\u6b7b\u94fe</button></div>';
          }).join("");
        }
        if (reachDisabled.length > 0) {
          html += '<div style="margin:var(--space-3) 0 var(--space-2)"><strong style="color:var(--teal)">\ud83d\udd04 \u5df2\u53ef\u8fbe\u4f46\u5f53\u524d\u4e3a\u6b7b\u94fe\uff08\u5efa\u8bae\u6062\u590d\u4e3a\u53ef\u7528\uff09(' + reachDisabled.length + ')</strong></div>';
          html += reachDisabled.map(function(r) {
            var s = byUrl[r.url];
            return '<div class="section-header" style="padding:var(--space-1) 0;font-size:12px;border-bottom:1px solid var(--line)">' +
              '<span style="flex:1;word-break:break-all"><a href="' + esc(r.url) + '" target="_blank">' + esc(s.name) + '</a> <span style="color:var(--muted)">' + esc(r.url) + '</span></span>' +
              '<span style="color:var(--teal);white-space:nowrap">HTTP ' + r.status + '</span>' +
              '<button class="btn btn-sm btn-primary" data-name="' + esc(s.name) + '" data-action="restore-dead">\u6062\u590d\u4e3a\u53ef\u7528</button></div>';
          }).join("");
        }
        html += '<div style="margin:var(--space-3) 0 var(--space-1);color:var(--muted);font-size:12px">\u5df2\u4e00\u81f4\uff08\u65e0\u9700\u64cd\u4f5c\uff09\uff1a\u4e0d\u53ef\u8fbe\u4e14\u5df2\u6807\u8bb0\u6b7b\u94fe ' + (allResults.length - unreachEnabled.length - reachDisabled.length) + ' \u4e2a\uff1b\u53ef\u8fbe\u4e14\u53ef\u7528 0 \u4e2a\u3002</div>';
        var msg = "检查完成：" + alive + " 正常，" + dead + " 不可达";
        if (unreachEnabled.length > 0) msg += "（" + unreachEnabled.length + " 个待标记死链）";
        if (reachDisabled.length > 0) msg += "（" + reachDisabled.length + " 个待恢复）";
        if (unreachEnabled.length > 0 || reachDisabled.length > 0) msg += "，请切换到链接健康标签页查看详情及操作。";
        statusEl.textContent = msg;
        toast(msg, (unreachEnabled.length > 0 || reachDisabled.length > 0) ? "info" : "success");
        loadSites();
      },
    });
  } catch (e) { statusEl.textContent = "检查失败: " + e.message; toast("检查失败: " + e.message, "error"); }
}
// ── 用户反馈管理 ──────────────────────────────────────────────────────────
async function loadFeedbacks() {
  try {
    var status = document.getElementById("fbFilter").value;
    var qs = status ? ("?status=" + status) : "";
    var data = await api("/api/admin/feedbacks" + qs);
    var list = document.getElementById("feedbacksList");
    var statusEl = document.getElementById("fbStatus");
    var countEl = document.getElementById("fbCount");
    var feedbacks = data.feedbacks || [];
    statusEl.textContent = "共 " + (data.total || 0) + " 条" + (data.unread ? "（" + data.unread + " 条未读）" : "");
    if (data.unread > 0) { countEl.textContent = data.unread; countEl.style.display = "inline"; } else { countEl.style.display = "none"; }
    if (feedbacks.length === 0) { list.innerHTML = '<div class="empty-state">暂无反馈</div>'; return; }

    // 批量操作栏（HTML 中已静态定义，此处确保显示）
    var batchBar = document.getElementById("fbBatchBar");
    if (batchBar) { batchBar.style.display = ""; }

    var typeColors = { error: "var(--coral)", correction: "var(--amber)", positive: "var(--teal)" };
    var typeLabels = { error: "报错", correction: "纠正", positive: "好评" };
    var statusLabels = { new: "🆕 待处理", read: "👁️ 已读", resolved: "✅ 已解决" };
    list.innerHTML = feedbacks.map(function(f) {
      var time = fmtTime(f.createdAt);
      var statusClass = f.status === "new" ? "font-semibold" : "text-muted";
      var typeClass = f.type === "error" ? "badge-danger" : f.type === "correction" ? "badge-warning" : f.type === "positive" ? "badge-success" : "badge-neutral";
      var borderColor = typeColors[f.type] || "var(--line)";
      return '<div class="sub-card" style="border-left:3px solid ' + borderColor + '">' +
        '<div class="sub-header"><span class="sub-name">' + esc(f.siteName) + '</span>' +
        '<span class="sub-time">' + esc(time) + ' | ' + esc(f.ip) + '</span></div>' +
        '<div class="mt-1"><span class="badge ' + typeClass + '">' + esc(typeLabels[f.type] || f.type) + '</span> ' +
        '<span class="' + statusClass + ' text-sm">' + esc(statusLabels[f.status] || f.status) + '</span></div>' +
        '<div class="sub-summary" style="white-space:normal">' + esc(f.content) + '</div>' +
        '<div class="sub-actions">' +
        '<input type="checkbox" class="fb-check" data-fb-id="' + f.id + '"> ' +
        (f.status !== "read" ? '<button class="btn btn-sm" data-fb-id="' + f.id + '" data-fb-action="read" data-action="fb-action">👁️ 标记已读</button> ' : '') +
        (f.status !== "resolved" ? '<button class="btn btn-sm btn-primary" data-fb-id="' + f.id + '" data-fb-action="resolved" data-action="fb-action">✅ 已解决</button> ' : '') +
        '<button class="btn btn-sm btn-danger" data-fb-id="' + f.id + '" data-fb-action="delete" data-action="fb-action">🗑️ 删除</button>' +
        '</div></div>';
    }).join("");
    list.querySelectorAll(".fb-check").forEach(function(cb) {
      cb.addEventListener("change", updateFeedbackBatchCount);
    });
    updateFeedbackBatchCount();
  } catch (e) { toast("加载反馈失败: " + e.message, "error"); }
}
function updateFeedbackBatchCount() {
  var countEl = document.getElementById("fbBatchCount");
  if (countEl) {
    var checked = document.querySelectorAll("#feedbacksList .fb-check:checked");
    countEl.textContent = checked.length;
  }
}
function clearFeedbackSelection() {
  document.querySelectorAll("#feedbacksList .fb-check").forEach(function(cb) { cb.checked = false; });
  updateFeedbackBatchCount();
}
async function batchFeedbackAction(action) {
  var checked = document.querySelectorAll("#feedbacksList .fb-check:checked");
  var ids = Array.from(checked).map(function(cb) { return parseInt(cb.getAttribute("data-fb-id")); });
  if (ids.length === 0) { toast("请先选择要处理的反馈", "info"); return; }
  var ok = action === "delete" ? await showConfirm("确认删除", "<p>将删除 <strong>" + ids.length + "</strong> 条反馈</p>", "", "删除") : true;
  if (!ok) return;
  try {
    var data = await api("/api/admin/feedbacks/batch", { method: "POST", body: JSON.stringify({ action: action, ids: ids }) });
    toast("已处理 " + data.affected + " 条反馈", "success");
    await loadFeedbacks();
  } catch (e) { toast(e.message, "error"); }
}
async function feedbackAction(id, action) {
  if (action === "delete") {
    var ok = await showConfirm("确认删除", "<p>删除后无法恢复，确认删除此反馈？</p>", "", "删除");
    if (!ok) return;
  }
  try {
    await api("/api/admin/feedbacks/" + id, { method: "POST", body: JSON.stringify({ action: action }) });
    toast("操作成功", "success");
    await loadFeedbacks();
  } catch (e) { toast(e.message, "error"); }
}
async function loadSchema() {
  try { const data = await api("/api/admin/schema"); document.getElementById("schemaEditor").value = JSON.stringify(data.schema, null, 2); document.getElementById("schemaStatus").textContent = "已加载"; } catch (e) { document.getElementById("schemaStatus").textContent = "加载失败: " + e.message; }
}
async function saveSchema() {
  const editor = document.getElementById("schemaEditor"); let schema;
  try { schema = JSON.parse(editor.value); } catch (e) { toast("JSON 格式错误: " + e.message, "error"); return; }
  try { const data = await api("/api/admin/schema", { method: "PUT", body: JSON.stringify(schema) }); editor.value = JSON.stringify(data.schema, null, 2); document.getElementById("schemaStatus").textContent = "保存成功"; toast("Schema 已保存", "success"); } catch (e) { toast("保存失败: " + e.message, "error"); }
}
function exportSchema() {
  const text = document.getElementById("schemaEditor").value;
  if (!text) { toast("没有 Schema 数据", "error"); return; }
  var blob = new Blob([text], { type: "application/json" }); var url = URL.createObjectURL(blob); var a = document.createElement("a"); a.href = url; a.download = "schema.json"; a.click(); URL.revokeObjectURL(url);
}
function importSchema() {
  var input = document.createElement("input"); input.type = "file"; input.accept = ".json";
  input.onchange = function(e) { var file = e.target.files[0]; if (!file) return; var reader = new FileReader(); reader.onload = function(ev) { document.getElementById("schemaEditor").value = ev.target.result; document.getElementById("schemaStatus").textContent = "已导入（未保存）"; toast("Schema 已导入，请检查后点击保存", "success"); }; reader.readAsText(file); };
  input.click();
}
function exportSites() {
  api("/api/admin/export").then(function(res) {
    if (!res.ok) { toast("导出失败: " + res.status, "error"); return; }
    return res.text();
  }).then(function(text) {
    if (!text) return;
    var blob = new Blob([text], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "sites-export.json";
    a.click();
    URL.revokeObjectURL(url);
    toast("导出成功");
  }).catch(function(e) { toast(e.message || "网络错误", "error"); });
}
let IMPORT_DATA = null;
function showImport() { IMPORT_DATA = null; document.getElementById("importFile").value = ""; document.getElementById("importPreview").style.display = "none"; document.getElementById("importBtn").disabled = true; document.getElementById("importOverwrite").checked = false; document.getElementById("importSkipDead").checked = true; _modalOpen(); document.getElementById("importModal").classList.add("active"); }
function closeImportModal() { document.getElementById("importModal").classList.remove("active"); IMPORT_DATA = null; _modalClose(); }
function previewImport(input) {
  const file = input.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => { try { const raw = JSON.parse(e.target.result); let sites = Array.isArray(raw) ? raw : (raw.sites || []); sites = sites.filter((s) => s && s.name && s.url); if (sites.length === 0) { toast("未找到有效站点数据", "error"); return; } IMPORT_DATA = sites; document.getElementById("importCount").textContent = sites.length; var deadWarnings = []; sites.forEach((s) => { if (s.url) { var deadInfo = DEAD_URLS.get(s.url.replace(/[/]+$/, "")); if (deadInfo) { var detail = "（added_at: " + fmtTime(deadInfo.added_at) + ", reason: " + esc(deadInfo.reason) + "）"; deadWarnings.push(s.name + detail); } } }); var html = sites.slice(0, 10).map((s) => { var line = "<div style='margin:2px 0'>• " + esc(s.name); if (s.url) { var deadInfo2 = DEAD_URLS.get(s.url.replace(/[/]+$/, "")); if (deadInfo2) { var detail2 = "（added_at: " + fmtTime(deadInfo2.added_at) + ", reason: " + esc(deadInfo2.reason) + "）"; line += " <span style='color:var(--amber);font-weight:600'>⚠️ 已知死链</span>" + detail2; } line += " → " + esc(s.url.slice(0, 50)) + (s.url.length > 50 ? "..." : ""); } return line + "</div>"; }).join(""); if (deadWarnings.length > 0) html += "<div style='margin-top:8px;padding:8px;background:var(--amber-soft);border-radius:var(--radius);border:1px solid var(--amber);color:var(--amber);font-weight:600'>⚠️ 已知死链（" + deadWarnings.length + " 条）：" + esc(deadWarnings.join("、")) + "</div>"; if (sites.length > 10) html += "<div style='color:var(--muted)'>... 共 " + sites.length + " 条</div>"; document.getElementById("importPreviewBox").innerHTML = html; document.getElementById("importPreview").style.display = "block"; document.getElementById("importBtn").disabled = false; } catch (err) { toast("JSON 解析失败: " + err.message, "error"); } };
  reader.readAsText(file);
}
async function doImport() {
  if (!IMPORT_DATA || IMPORT_DATA.length === 0) { toast("无数据可导入", "error"); return; }
  const overwrite = document.getElementById("importOverwrite").checked;
  const skipDead = document.getElementById("importSkipDead").checked;
  document.getElementById("importBtn").disabled = true;
  try { const data = await api("/api/admin/sites/import", { method: "POST", body: JSON.stringify({ sites: IMPORT_DATA, overwrite, skipDead }) }); let msg = "导入完成：新增 " + data.added + " 条"; if (data.updated) msg += "，更新 " + data.updated + " 条"; if (data.skipped) msg += "，跳过 " + data.skipped + " 条"; if (data.skippedDead) msg += "（其中已知死链 " + data.skippedDead + " 条）"; if (data.duplicates && data.duplicates.length > 0) msg += "\n重复站点：" + data.duplicates.map((d) => d.existingName).join(", "); toast(msg, "success"); closeImportModal(); await loadSites(); } catch (e) { toast(e.message, "error"); document.getElementById("importBtn").disabled = false; }
}
// 按钮加载状态（防重复点击 + 视觉反馈）
function btnLoading(btn, loading) {
  if (!btn) return;
  btn.disabled = loading;
  if (loading) btn.classList.add("btn-loading");
  else btn.classList.remove("btn-loading");
}

// Toast 堆叠队列（最多 4 条，避免覆盖）
var _toastQueue = [];
var _toastMax = 4;
function toast(msg, type) {
  var stack = document.getElementById("toastStack");
  var el = document.createElement("div");
  el.className = "toast " + (type || "info");
  el.textContent = msg;
  stack.appendChild(el);
  _toastQueue.push(el);
  while (_toastQueue.length > _toastMax) {
    var old = _toastQueue.shift();
    if (old && old.parentNode) old.parentNode.removeChild(old);
  }
  setTimeout(function() {
    el.classList.add("removing");
    setTimeout(function() {
      if (el.parentNode) el.parentNode.removeChild(el);
      _toastQueue = _toastQueue.filter(function(t) { return t !== el; });
    }, 300);
  }, 3000);
}

// 自定义确认弹窗（替代原生 confirm）
var _confirmCb = null;
var _modalCount = 0;
function _modalOpen() { _modalCount++; document.body.classList.add("modal-open"); }
function _modalClose() { _modalCount = Math.max(0, _modalCount - 1); if (_modalCount === 0) document.body.classList.remove("modal-open"); }
function showConfirm(title, body, extraHtml, okText) {
  return new Promise(function(resolve) {
    _confirmCb = resolve;
    document.getElementById("confirmTitle").textContent = title || "确认操作";
    document.getElementById("confirmBody").innerHTML = body || "";
    var extra = document.getElementById("confirmExtra");
    extra.innerHTML = extraHtml || "";
    document.getElementById("confirmOkBtn").textContent = okText || "确认";
    _modalOpen();
    document.getElementById("confirmModal").classList.add("active");
  });
}
function confirmResolve(result) {
  if (!_confirmCb) return;
  var modal = document.getElementById("confirmModal");
  modal.classList.add("closing");
  _modalClose();
  setTimeout(function() { modal.classList.remove("active", "closing"); }, 150);
  var cb = _confirmCb;
  _confirmCb = null;
  cb(result);
}
// 点击遮罩关闭
document.getElementById("confirmModal").addEventListener("click", function(e) {
  if (e.target === this) confirmResolve(false);
});
// ESC 关闭
document.addEventListener("keydown", function(e) {
  if (e.key === "Escape" && document.getElementById("confirmModal").classList.contains("active")) {
    confirmResolve(false);
  }
  // 批量标签输入框回车提交
  if (e.key === "Enter" && document.activeElement && document.activeElement.id === "batchTagInput") {
    batchTag();
  }
});
if (TOKEN) { loadSites().then(() => loadDeadUrls()).then(() => { document.getElementById("loginView").style.display = "none"; document.getElementById("mainView").style.display = "block"; }).catch(() => { toast("密码错误", "error"); TOKEN = ""; localStorage.removeItem("sk-free-admin-token"); }); }
document.addEventListener("click", function(e) {
  var el = e.target.closest("[data-action]"); if (!el) return;
  var action = el.getAttribute("data-action");
  var name = el.getAttribute("data-name") || "";
  var id = el.getAttribute("data-id") || "";
  var tab = el.getAttribute("data-tab") || "";
  var resolve = el.getAttribute("data-resolve") || "";
  var mark = el.getAttribute("data-mark") || "";
  switch (action) {
    case "doLogin": doLogin(); break;
    case "loadSites": loadSites(); break;
    case "showCreate": showCreate(); break;
    case "showImport": showImport(); break;
    case "exportSites": exportSites(); break;
    case "doLogout": doLogout(); break;
    case "switchTab": if (tab) switchTab(tab); break;
    case "sitesCleanupDeadLinks": sitesCleanupDeadLinks(); break;
    case "batchRecheck": batchRecheck(); break;
    case "batchTag": batchTag(); break;
    case "batchEnable": batchEnable(); break;
    case "batchDisable": batchDisable(); break;
    case "batchDelete": batchDelete(); break;
    case "clearSelection": clearSelection(); break;
    case "batchCheckUrls": batchCheckUrls(); break;
    case "loadSchema": loadSchema(); break;
    case "exportSchema": exportSchema(); break;
    case "importSchema": importSchema(); break;
    case "saveSchema": saveSchema(); break;
    case "closeModal": closeModal(); break;
    case "saveSite": saveSite(); break;
    case "closeImportModal": closeImportModal(); break;
    case "doImport": doImport(); break;
    case "confirmResolve": confirmResolve(resolve === "true"); break;
    case "healthBatchRestoreDead": healthBatchRestoreDead(); break;
    case "healthBatchRecheckDead": healthBatchRecheckDead(); break;
    case "healthRestoreAllDead": healthRestoreAllDead(); break;
    case "healthClearDeadSelection": healthClearDeadSelection(); break;
    case "healthBatchMarkDead": healthBatchMarkDead(); break;
    case "healthClearFailSelection": healthClearFailSelection(); break;
    case "scanBatchMark": scanBatchMark(); break;
    case "scanBatchRestore": scanBatchRestore(); break;
    case "scanOne": scanOne(el, mark === "true"); break;
    case "toggle-select": toggleSelect(name, el.checked); break;
    case "toggle-enable": toggleEnable(name, el.checked); break;
    case "show-edit": showEdit(name); break;
    case "delete-site": deleteSite(name); break;
    case "approve-submission": approveSubmission(id); break;
    case "reject-submission": rejectSubmission(id); break;
    case "restore-dead": setDeadByName(name, false); break;
    case "mark-dead": setDeadByName(name, true); break;
    case "recheck-dead": healthRecheckSingleDead(name); break;
    case "fb-action": feedbackAction(el.getAttribute("data-fb-id"), el.getAttribute("data-fb-action")); break;
  }
});
document.addEventListener("input", function(e) {
  if (e.target.matches('[data-action="filterTable"]')) filterTable();
});
document.addEventListener("change", function(e) {
  var el = e.target;
  var action = el.getAttribute("data-action") || "";
  var name = el.getAttribute("data-name") || "";
  switch (action) {
    case "filterTable": filterTable(); break;
    case "loadFeedbacks": loadFeedbacks(); break;
    case "previewImport": previewImport(el); break;
    case "toggleSelectAll": toggleSelectAll(); break;
    case "healthToggleDeadSelectAll": healthToggleDeadSelectAll(el); break;
    case "healthToggleDeadSelect": healthToggleDeadSelect(el); break;
    case "healthToggleFailSelectAll": healthToggleFailSelectAll(el); break;
    case "healthToggleFailSelect": healthToggleFailSelect(el); break;
    case "scanToggleAll": scanToggleAll(el); break;
    case "scanCkChanged": scanCkChanged(el); break;
  }
});

// ── window 桥接 ──────────────────────────────────────────────────────────────
// admin.html 的静态按钮仍使用 onclick="fn()"（沿用旧版页面结构，零 diff）。
// ES 模块的顶层函数不会挂到 window，这里显式桥接，否则点击即 ReferenceError。
// 清单与 html 中 onclick 引用一一对应（构建前由 check-admin-html.mjs 校验）。
Object.assign(window, {
  doLogin, doLogout, loadSites, showCreate, showImport, exportSites,
  sitesCleanupDeadLinks, batchRecheck, batchTag, batchEnable, batchDisable,
  batchDelete, batchDeleteDisabled, clearSelection, switchTab, batchCheckUrls, closeModal, saveSite,
  closeImportModal, doImport, confirmResolve, loadSchema, exportSchema,
  importSchema, saveSchema, toggleSelectAll, filterTable, loadFeedbacks,
  batchFeedbackAction, clearFeedbackSelection, goToPage,
});
