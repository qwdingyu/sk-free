// ═══════════════════════════════════════════════════════════════════════════════
// index.js — Worker 入口：路由分发 + 管理页面 HTML
// 所有业务逻辑已拆分到 src/ 目录下的独立模块
// ═══════════════════════════════════════════════════════════════════════════════

// ── 模块导入 ──────────────────────────────────────────────────────────────────
import { getDb, dbAll, dbGet, dbBatch } from "./src/db.js";
import { DEFAULT_SCHEMA, getSchema, saveSchema } from "./src/schema.js";
import {
  corsHeaders, json, html, requireAuth,
  cleanupAdminRateMap, checkAdminRateLimit, parseJsonBody
} from "./src/utils.js";
import {
  handleGetSites, handleGetEnabledSites, handleAdminListSites,
  handleAdminCreateSite, handleAdminUpdateSite, handleAdminDeleteSite,
  handleAdminBatch, handleAdminExport, handleAdminImportSites
} from "./src/sites.js";
import { handleGetVotes, handleVote } from "./src/votes.js";
import { handleSubmitSite, handleAdminGetSubmissions, handleAdminSubmissionAction, handleAdminApproveSubmission } from "./src/submissions.js";
import { getDeadUrls, addDeadUrl, removeDeadUrl, batchDeadUrls } from "./src/deadurls.js";
import { checkUrlHealth, checkBatchHealth, HEALTH_BATCH_SIZE } from "./src/health.js";
import { handleSubmitFeedback, handleGetFeedbacks, handleFeedbackAction } from "./src/feedbacks.js";
import { broadcastHtml } from "./broadcast-html.js";

// ═══════════════════════════════════════════════════════════════════════════════
// 管理页面 HTML（前端 SPA，所有 CSS/JS 内联）
// ═══════════════════════════════════════════════════════════════════════════════

function getAdminHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>sk-free 管理后台</title>
<script>
(() => {
  var k="admin-theme",c="system";
  try{c=localStorage.getItem(k)||"system"}catch{}
  var pd=window.matchMedia&&window.matchMedia("(prefers-color-scheme:dark)").matches;
  document.documentElement.dataset.theme=(c==="system"?(pd?"dark":"light"):c);
  document.documentElement.dataset.themeChoice=c;
})();
</script>
<style>
:root{--bg:#f5f5f5;--surface:#fff;--ink:#1a1a1a;--muted:#666;--line:#e0e0e0;--teal:#087f78;--teal-soft:#e6f7f5;--red:#d32f2f;--red-soft:#fdeaea;--coral:#d32f2f;--amber:#f57c00;--amber-soft:#fff3e0;--green:#2e7d32;--radius:6px;--font:system-ui,-apple-system,sans-serif;--hover:#f0f0f0;--th-bg:#fafafa;--tag-bg:#eee;--shadow:0 1px 3px rgba(0,0,0,.08)}
[data-theme=dark]{--bg:#1a1d21;--surface:#23262b;--ink:#e0e0e0;--muted:#999;--line:#3a3d42;--teal:#4ecdc4;--teal-soft:#1a3a38;--red:#ef5350;--red-soft:#3a1a1a;--coral:#ef5350;--amber:#ffb74d;--amber-soft:#3a2a10;--green:#66bb6a;--hover:#2a2d32;--th-bg:#2a2d32;--tag-bg:#3a3d42;--shadow:0 1px 3px rgba(0,0,0,.3)}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--font);background:var(--bg);color:var(--ink);line-height:1.5;font-size:14px}
a{color:var(--teal);text-decoration:none}
.container{max-width:1200px;margin:0 auto;padding:16px}
.login-box{max-width:360px;margin:80px auto;padding:24px;background:var(--surface);border-radius:var(--radius);border:1px solid var(--line);text-align:center;box-shadow:var(--shadow)}
.login-box h2{margin-bottom:16px;font-size:18px}
.login-box input{width:100%;padding:10px;border:1px solid var(--line);border-radius:var(--radius);font-size:14px;margin-bottom:12px;background:var(--surface);color:var(--ink)}
.login-box button{width:100%;padding:10px;background:var(--teal);color:#fff;border:none;border-radius:var(--radius);font-size:14px;cursor:pointer;font-weight:700}
.login-box button:hover{opacity:.9}
.header{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--line);margin-bottom:16px;position:sticky;top:0;z-index:50;background:var(--bg);backdrop-filter:blur(8px)}
.header h1{font-size:18px;flex:1}
.header .count{color:var(--muted);font-size:13px}
.theme-toggle{display:inline-flex;gap:2px;padding:2px;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);cursor:pointer}
.theme-toggle button{padding:4px 8px;border:none;background:none;cursor:pointer;font-size:13px;border-radius:4px;color:var(--muted);transition:.15s}
.theme-toggle button.active{background:var(--teal);color:#fff}
.theme-toggle button:hover:not(.active){background:var(--hover)}
.btn{padding:6px 14px;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);color:var(--ink);cursor:pointer;font-size:13px;font-weight:600}
.btn:hover{background:var(--hover)}
.btn-primary{background:var(--teal);color:#fff;border-color:var(--teal)}
.btn-primary:hover{opacity:.9}
.btn-danger{background:var(--red);color:#fff;border-color:var(--red)}
.btn-danger:hover{opacity:.9}
.btn-sm{padding:4px 10px;font-size:12px}
.toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
.toolbar input[type="search"]{flex:1;min-width:200px;padding:8px 12px;border:1px solid var(--line);border-radius:var(--radius);font-size:13px;background:var(--surface);color:var(--ink)}
.table-wrap{overflow-x:auto;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius)}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{padding:8px 10px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap}
th{background:var(--th-bg);font-weight:700;position:sticky;top:0}
tr:hover{background:var(--hover)}
td.name{font-weight:600;max-width:180px;overflow:hidden;text-overflow:ellipsis}
td.tags{max-width:200px}
.tag{display:inline-block;padding:2px 6px;border-radius:3px;font-size:11px;font-weight:700;background:var(--tag-bg);margin:1px}
td.summary{max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted)}
td.actions{white-space:nowrap;position:sticky;right:0;background:var(--surface);border-left:1px solid var(--line);z-index:1}
th:last-child{position:sticky;right:0;background:var(--th-bg);border-left:1px solid var(--line);z-index:2}
.toggle{position:relative;display:inline-block;width:36px;height:20px;cursor:pointer}
.toggle input{opacity:0;width:0;height:0}
.toggle .slider{position:absolute;inset:0;background:var(--line);border-radius:20px;transition:.3s}
.toggle .slider::before{content:"";position:absolute;left:2px;bottom:2px;width:16px;height:16px;background:var(--surface);border-radius:50%;transition:.3s}
.toggle input:checked+.slider{background:var(--teal)}
.toggle input:checked+.slider::before{transform:translateX(16px)}
.sub-card{padding:12px;border:1px solid var(--line);border-radius:var(--radius);margin-bottom:8px;background:var(--surface)}
.sub-card .sub-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.sub-card .sub-name{font-weight:700;font-size:14px}
.sub-card .sub-time{color:var(--muted);font-size:12px}
.sub-card .sub-url{color:var(--teal);font-size:12px;word-break:break-all}
.sub-card .sub-summary{color:var(--muted);font-size:13px;margin-top:4px}
.sub-card .sub-actions{margin-top:8px;display:flex;gap:6px}
.sub-empty{color:var(--muted);padding:20px;text-align:center}
.tab-bar{display:flex;gap:0;border-bottom:2px solid var(--line);margin-bottom:16px}
.tab-btn{padding:10px 18px;border:none;background:none;cursor:pointer;font-size:14px;font-weight:600;color:var(--muted);border-bottom:2px solid transparent;margin-bottom:-2px}
.tab-btn:hover{color:var(--ink)}
.tab-btn.active{color:var(--teal);border-bottom-color:var(--teal)}
.tab-panel{display:none}
.tab-panel.active{display:block}
td.url-cell{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
td.url-cell .orig-url{display:block;color:var(--muted);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:100;justify-content:center;align-items:center}
.modal-overlay.active{display:flex}
.modal{background:var(--surface);border-radius:var(--radius);padding:20px;width:min(560px,92vw);max-height:85vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,.2)}
.modal h3{margin-bottom:16px;font-size:16px}
.form-row{margin-bottom:12px}
.form-row label{display:block;margin-bottom:4px;font-weight:600;font-size:13px}
.form-row input,.form-row textarea,.form-row select{width:100%;padding:8px;border:1px solid var(--line);border-radius:var(--radius);font-size:13px;font-family:inherit;background:var(--surface);color:var(--ink)}
.form-row textarea{min-height:60px;resize:vertical}
.form-row .hint{font-size:11px;color:var(--muted);margin-top:2px}
.form-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
.batch-bar{display:none;padding:10px 14px;background:var(--teal-soft);border-radius:var(--radius);margin-bottom:12px;align-items:center;gap:12px;font-size:13px}
.batch-bar.active{display:flex}
.batch-bar .count{font-weight:700}
.toast{position:fixed;bottom:20px;right:20px;padding:12px 20px;border-radius:var(--radius);color:#fff;font-size:13px;font-weight:600;z-index:200;transform:translateY(80px);opacity:0;transition:.3s}
.toast.show{transform:translateY(0);opacity:1}
.toast.success{background:var(--green)}
.toast.error{background:var(--red)}
.toast.info{background:var(--teal)}
@media(max-width:768px){.toolbar{flex-direction:column}.toolbar input[type="search"]{min-width:0;width:100%}th,td{padding:6px 8px}}
</style>
</head>
<body>
<div id="loginView" class="container">
  <div class="login-box">
    <h2>🔐 sk-free 管理后台</h2>
    <input id="tokenInput" type="password" placeholder="输入管理密码" autofocus>
    <button onclick="doLogin()">登 录</button>
  </div>
</div>
<div id="mainView" class="container" style="display:none">
  <div class="header">
    <h1>📋 站点管理</h1>
    <span class="count" id="siteCount"></span>
    <div class="theme-toggle">
      <button type="button" data-admin-theme="light" title="亮色">☀️</button>
      <button type="button" data-admin-theme="dark" title="暗色">🌙</button>
      <button type="button" data-admin-theme="system" title="跟随系统">💻</button>
    </div>
    <button class="btn" onclick="loadSites()">🔄 刷新</button>
    <button class="btn" onclick="showCreate()">➕ 新增</button>
    <button class="btn" onclick="showImport()">📥 导入</button>
    <button class="btn" onclick="exportSites()">📤 导出</button>
    <button class="btn btn-danger btn-sm" onclick="doLogout()">退出</button>
  </div>
  <div class="tab-bar">
    <button class="tab-btn active" data-tab="sites" onclick="switchTab('sites')">站点管理</button>
    <button class="tab-btn" data-tab="submissions" onclick="switchTab('submissions')">提交审核 <span id="subCount" class="tag" style="display:none;background:var(--red);color:#fff"></span></button>
    <button class="tab-btn" data-tab="health" onclick="switchTab('health')">🔗 链接健康</button>
    <button class="tab-btn" data-tab="feedback" onclick="switchTab('feedback')">💬 用户反馈 <span id="fbCount" class="tag" style="display:none;background:var(--red);color:#fff"></span></button>
    <button class="tab-btn" data-tab="schema" onclick="switchTab('schema')">⚙️ Schema</button>
  </div>
  <div id="panelSites" class="tab-panel active">
    <div class="toolbar">
      <input type="search" id="searchInput" placeholder="搜索站名、域名、标签..." oninput="filterTable()">
      <select id="tagFilter" onchange="filterTable()" style="padding:8px;border:1px solid var(--line);border-radius:var(--radius);font-size:13px;background:var(--surface);color:var(--ink)">
        <option value="">全部标签</option>
      </select>
      <button class="btn btn-danger btn-sm" onclick="sitesCleanupDeadLinks()">🧹 一键清理死链</button>
      <span id="sitesCleanStatus" style="color:var(--muted);font-size:12px"></span>
    </div>
    <div class="batch-bar" id="batchBar">
      <span>已选 <span class="count" id="batchCount">0</span> 项</span>
      <button class="btn btn-sm" onclick="batchTag()">🏷️ 批量打标签</button>
      <button class="btn btn-sm" onclick="batchEnable()">✅ 批量启用</button>
      <button class="btn btn-sm" onclick="batchDisable()">⛔ 批量停用</button>
      <button class="btn btn-sm btn-danger" onclick="batchDelete()">🗑️ 批量删除</button>
      <button class="btn btn-sm" onclick="clearSelection()">取消选择</button>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th style="width:30px"><input type="checkbox" id="selectAll" onchange="toggleSelectAll()"></th>
            <th>启用</th>
            <th>站点名称</th>
            <th>标签</th>
            <th>签到</th>
            <th>Ref</th>
            <th>模型</th>
            <th>倍率</th>
            <th>摘要</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody id="sitesBody"></tbody>
      </table>
    </div>
  </div>
  <div id="panelSubmissions" class="tab-panel">
    <div id="submissionsList"></div>
  </div>
  <div id="panelHealth" class="tab-panel">
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
      <button class="btn btn-primary btn-sm" onclick="batchCheckUrls()">🔍 批量检查所有站点</button>
      <span id="healthStatus" style="color:var(--muted);font-size:13px"></span>
    </div>
    <div id="healthResults"></div>
    <h4 style="margin:16px 0 8px">死链站点名单 <span id="deadCount" style="color:var(--muted);font-size:13px"></span></h4>
    <div class="batch-bar" id="deadBatchBar">
      <span>已选 <span class="count" id="deadBatchCount">0</span> 项</span>
      <button class="btn btn-sm btn-primary" onclick="batchRestoreDead()">✅ 批量恢复</button>
      <button class="btn btn-sm btn-danger" onclick="restoreAllDeadUrls()">🧹 一键恢复全部</button>
      <button class="btn btn-sm" onclick="clearDeadSelection()">取消选择</button>
    </div>
    <div id="deadUrlsList"></div>
  </div>
  <div id="panelFeedback" class="tab-panel">
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
      <select id="fbFilter" onchange="loadFeedbacks()" style="padding:8px;border:1px solid var(--line);border-radius:var(--radius);font-size:13px;background:var(--surface);color:var(--ink)">
        <option value="">全部状态</option>
        <option value="new">🆕 待处理</option>
        <option value="read">👁️ 已读</option>
        <option value="resolved">✅ 已解决</option>
      </select>
      <span id="fbStatus" style="color:var(--muted);font-size:13px"></span>
    </div>
    <div id="feedbacksList"></div>
  </div>
  <div id="panelSchema" class="tab-panel">
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
      <button class="btn btn-primary btn-sm" onclick="loadSchema()">🔄 加载 Schema</button>
      <button class="btn btn-sm" onclick="exportSchema()">📤 导出</button>
      <button class="btn btn-sm" onclick="importSchema()">📥 导入</button>
      <span id="schemaStatus" style="color:var(--muted);font-size:13px"></span>
    </div>
    <div class="form-row">
      <label>Schema JSON（编辑后点击保存）</label>
      <textarea id="schemaEditor" rows="20" style="font-family:monospace;font-size:12px;tab-size:2" placeholder="正在加载..."></textarea>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">
      <button class="btn" onclick="loadSchema()">↩️ 重置</button>
      <button class="btn btn-primary" onclick="saveSchema()">💾 保存 Schema</button>
    </div>
    <div style="margin-top:16px;padding:12px;background:var(--teal-soft);border-radius:var(--radius);font-size:13px">
      <strong>💡 Schema 使用说明</strong>
      <ul style="margin:8px 0 0 16px;line-height:1.8">
        <li><code>fields</code>: 定义站点字段（key/label/type/required/unique/healthCheck/options/max）</li>
        <li><code>tags</code>: 全局标签选项列表</li>
        <li><code>display</code>: 前端展示配置（layout/columns/sortBy/priorityTags）</li>
        <li><code>submit</code>: 用户提交配置（enabled/rateLimit/fields）</li>
        <li><code>healthCheck</code>: URL 健康检查配置（enabled/timeout/autoBlock/blockOnImport）</li>
        <li><code>theme</code>: 主题配色（primary/accent/style）</li>
        <li>字段类型: text, url, textarea, number, tags, list, select, boolean, date, rating</li>
      </ul>
    </div>
  </div>
</div>
<div class="modal-overlay" id="editModal">
  <div class="modal">
    <h3 id="editTitle">新增站点</h3>
    <input type="hidden" id="editOriginalName">
    <div class="form-row"><label>站点名称 *</label><input id="editName" placeholder="如：JustDoWork"></div>
    <div class="form-row"><label>URL *</label><input id="editUrl" placeholder="https://..."></div>
    <div class="form-row"><label>原始 URL（导入时保留）</label><input id="editOriginalUrl" placeholder="自动保留，无需手动填写"><div class="hint">导入时自动从 URL 剥离 aff/ref 等参数，此字段保留原始完整 URL</div></div>
    <div class="form-row"><label>标签（逗号分隔）</label><input id="editTags" placeholder="签到, 生图, 非DC"><div class="hint">可选：签到、生图、DC系、半DC、非DC、限免、抽奖、按次、账号、域名、交易</div></div>
    <div class="form-row"><label>摘要</label><textarea id="editSummary" placeholder="站点简要描述"></textarea></div>
    <div class="form-row"><label>签到额度</label><input id="editCheckin" placeholder="如：每日签到 5-50 刀"></div>
    <div class="form-row"><label>模型</label><input id="editModels" placeholder="如：Claude Opus 5、GPT-5.6"></div>
    <div class="form-row"><label>倍率</label><input id="editRate" placeholder="如：0.1"></div>
    <div class="form-row"><label>注册方式</label><input id="editRegister" placeholder="如：GitHub、邮箱"></div>
    <div class="form-row"><label>邀请码 (ref)</label><input id="editRef" placeholder="如：aff=FWQS 或 ref=ABC123"><div class="hint">导入时自动从 URL 剥离 aff/ref/invite 等推广参数存入此字段</div></div>
    <div class="form-row"><label>备注（每行一条）</label><textarea id="editNotes" placeholder="第一行备注&#10;第二行备注"></textarea></div>
    <!-- ── 0003 结构化字段 ────────────────────────────────────────────────────
         这些字段决定前端能不能"横向比较"：额度档位驱动排序，单位/周期决定
         展示成"25 刀/天"还是"额度未知"。之前后端 API 已经能收，但表单里
         一个输入框都没有 —— 结果是从后台新建的站点，结构化字段全是 NULL，
         额度那栏永远显示"未知"，只有直接写 SQL 或走导入才能填上。
         枚举值必须与 worker/src/sites.js 的 QUOTA_* / SITE_KINDS 完全一致，
         中文标签与 broadcast/src/00-config.js 保持一致，避免两边叫法不同。 -->
    <div class="form-row" style="border-top:1px solid var(--border);padding-top:14px;margin-top:6px">
      <label style="font-weight:600">结构化额度（决定前端排序与"25 刀/天"这类展示）</label>
      <div class="hint">留空 = 未知，前端会诚实显示"未知"，不会编造。跨单位没有汇率，排序只看档位。</div>
    </div>
    <div class="form-row"><label>额度档位（排序依据）</label>
      <select id="editQuotaTier">
        <option value="">未设置（未知）</option>
        <option value="high">高</option>
        <option value="mid">中</option>
        <option value="low">低</option>
        <option value="none">无额度</option>
      </select>
      <div class="hint">人工判定。刀/元/积分互不可换算，所以排序不比数值、只比档位。</div>
    </div>
    <div class="form-row"><label>额度下限</label><input id="editQuotaMin" type="number" step="any" placeholder="如：25"></div>
    <div class="form-row"><label>额度上限</label><input id="editQuotaMax" type="number" step="any" placeholder="区间额度填上限，固定额度与下限填同值"></div>
    <div class="form-row"><label>额度单位</label>
      <select id="editQuotaUnit">
        <option value="">未设置</option>
        <option value="usd">刀 (usd)</option>
        <option value="cny">元 (cny)</option>
        <option value="credit">积分 (credit)</option>
        <option value="coin">硬币 (coin)</option>
        <option value="token">代币 (token)</option>
        <option value="call">次 (call)</option>
      </select>
    </div>
    <div class="form-row"><label>额度周期</label>
      <select id="editQuotaPeriod">
        <option value="">未设置</option>
        <option value="daily">每日</option>
        <option value="weekly">每周</option>
        <option value="once">一次性</option>
        <option value="none">无周期</option>
      </select>
      <div class="hint">选"每日"且额度下限 &gt; 0 才会进前端"今天能签到"筛选。</div>
    </div>
    <div class="form-row"><label>估算可调用次数</label><input id="editQuotaCallsEst" type="number" step="1" placeholder="如：100"></div>
    <div class="form-row"><label>额度原文</label><input id="editQuotaRaw" placeholder="如：每日签到送 25 刀"><div class="hint">拿不到结构化数值时，前端退回展示这段原文。留空则用"签到额度"兜底。</div></div>
    <div class="form-row"><label>站点类型</label>
      <select id="editKind">
        <option value="">未设置（前端按 API站 处理）</option>
        <option value="api_site">API站</option>
        <option value="bot">机器人</option>
        <option value="account_pool">号池</option>
        <option value="tool">工具</option>
      </select>
    </div>
    <div class="form-row"><label>是否需要代理</label>
      <select id="editNeedsProxy">
        <option value="">未知</option>
        <option value="1">需要</option>
        <option value="0">不需要</option>
      </select>
    </div>
    <div class="form-row"><label>slug（URL 短标识）</label><input id="editSlug" placeholder="留空则不设置"><div class="hint">全站唯一。留空写 NULL，不会与其它空 slug 冲突。</div></div>
    <div class="form-actions">
      <button class="btn" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" onclick="saveSite()">保存</button>
    </div>
  </div>
</div>
<div class="modal-overlay" id="importModal">
  <div class="modal">
    <h3>📥 批量导入站点</h3>
    <div class="form-row"><label>选择 JSON 文件</label><input type="file" id="importFile" accept=".json" onchange="previewImport(this)"><div class="hint">支持 sites.json 格式或自定义 JSON 数组，自动剥离 URL 中的 aff/ref/invite 等推广参数</div></div>
    <div class="form-row" id="importPreview" style="display:none"><label>预览（将导入 <span id="importCount">0</span> 条）</label><textarea id="importPreviewText" readonly style="min-height:120px;font-size:12px;font-family:monospace"></textarea></div>
    <div class="form-row"><label><input type="checkbox" id="importOverwrite"> 覆盖已存在的同 URL 站点</label><div class="hint">不勾选时，同 URL 站点会被跳过；勾选时会更新已有站点信息</div></div>
    <div class="form-actions">
      <button class="btn" onclick="closeImportModal()">取消</button>
      <button class="btn btn-primary" id="importBtn" onclick="doImport()" disabled>开始导入</button>
    </div>
  </div>
</div>
<div class="toast" id="toast"></div>
<script>
let TOKEN = localStorage.getItem("sk-free-admin-token") || "";
let SITES = [];
let SELECTED = new Set();
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
  loadSites().then(() => { document.getElementById("loginView").style.display = "none"; document.getElementById("mainView").style.display = "block"; }).catch(() => { toast("密码错误", "error"); TOKEN = ""; localStorage.removeItem("sk-free-admin-token"); });
}
function doLogout() { TOKEN = ""; localStorage.removeItem("sk-free-admin-token"); document.getElementById("loginView").style.display = "block"; document.getElementById("mainView").style.display = "none"; }
document.getElementById("tokenInput").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
async function loadSites() {
  const data = await api("/api/admin/sites");
  SITES = data.sites || [];
  document.getElementById("siteCount").textContent = SITES.length + " 个站点";
  buildTagFilter();
  renderTable();
}
function buildTagFilter() {
  const tags = [...new Set(SITES.flatMap((s) => s.tags || []))].sort();
  const sel = document.getElementById("tagFilter");
  const current = sel.value;
  sel.innerHTML = '<option value="">全部标签</option>' + tags.map((t) => '<option value="' + esc(t) + '">' + esc(t) + '</option>').join("");
  sel.value = current;
}
function renderTable() {
  const q = document.getElementById("searchInput").value.toLowerCase();
  const tag = document.getElementById("tagFilter").value;
  const filtered = SITES.filter((s) => {
    const haystack = [s.name, s.url, s.summary, s.checkin, s.models, s.rate, ...(s.tags || [])].join(" ").toLowerCase();
    return (!q || haystack.includes(q)) && (!tag || (s.tags || []).includes(tag));
  });
  const tbody = document.getElementById("sitesBody");
  tbody.innerHTML = filtered.map((s) => {
    const tags = (s.tags || []).map((t) => '<span class="tag">' + esc(t) + '</span>').join("");
    const checked = SELECTED.has(s.name) ? "checked" : "";
    const toggleChecked = s.enabled !== false ? "checked" : "";
    const deadBadge = s.dead ? '<span class="tag" style="background:var(--coral);color:#fff" title="已标记为死链（不可用）">死链</span>' : '';
    const origUrlHtml = s.originalUrl && s.originalUrl !== s.url ? '<span class="orig-url" title="' + esc(s.originalUrl) + '">原: ' + esc(s.originalUrl.slice(0, 40)) + (s.originalUrl.length > 40 ? '...' : '') + '</span>' : '';
    return '<tr>' +
      '<td><input type="checkbox" ' + checked + ' data-name="' + esc(s.name) + '" data-action="toggle-select"></td>' +
      '<td><label class="toggle"><input type="checkbox" ' + toggleChecked + ' data-name="' + esc(s.name) + '" data-action="toggle-enable"><span class="slider"></span></label></td>' +
      '<td class="name"><a href="' + esc(s.url) + '" target="_blank" title="' + esc(s.url) + '">' + esc(s.name) + '</a>' + deadBadge + origUrlHtml + '</td>' +
      '<td class="tags">' + tags + '</td>' +
      '<td>' + esc(s.checkin || "") + '</td>' +
      '<td title="' + esc(s.ref || "") + '">' + esc(s.ref || "") + '</td>' +
      '<td>' + esc(s.models || "") + '</td>' +
      '<td>' + esc(s.rate || "") + '</td>' +
      '<td class="summary" title="' + esc(s.summary || "") + '">' + esc(s.summary || "") + '</td>' +
      '<td class="actions"><button class="btn btn-sm" data-name="' + esc(s.name) + '" data-action="show-edit">编辑</button> <button class="btn btn-sm btn-danger" data-name="' + esc(s.name) + '" data-action="delete-site">删除</button></td>' +
    '</tr>';
  }).join("");
}
function filterTable() { renderTable(); }
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
  document.querySelectorAll('#sitesBody input[data-action="toggle-select"]').forEach((cb) => { cb.checked = checked; const name = cb.closest("tr").querySelector(".name a").textContent; if (checked) SELECTED.add(name); else SELECTED.delete(name); });
  updateBatchBar();
}
function clearSelection() { SELECTED.clear(); document.getElementById("selectAll").checked = false; document.querySelectorAll('#sitesBody input[data-action="toggle-select"]').forEach((cb) => cb.checked = false); updateBatchBar(); }
function updateBatchBar() { const bar = document.getElementById("batchBar"); const count = SELECTED.size; document.getElementById("batchCount").textContent = count; bar.classList.toggle("active", count > 0); }
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
  document.getElementById("editNotes").value = (site.notes || []).join("\\n");
  // 结构化字段回填：null/undefined → 空字符串（对应各 select 的"未设置"项）。
  // 注意不能用 || ""：quotaMin=0 和 needsProxy=0 都是有效值，会被 || 吃掉变成未设置。
  STRUCT_FIELDS.forEach(function (f) {
    const v = site[f[1]];
    document.getElementById(f[0]).value = v === null || v === undefined ? "" : String(v);
  });
  document.getElementById("editModal").classList.add("active");
}
function closeModal() { document.getElementById("editModal").classList.remove("active"); }
async function saveSite() {
  const originalName = document.getElementById("editOriginalName").value;
  const tags = document.getElementById("editTags").value.split(",").map((t) => t.trim()).filter(Boolean);
  const notes = document.getElementById("editNotes").value.split("\\n").map((t) => t.trim()).filter(Boolean);
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
  if (!confirm('确认删除 "' + name + '" ？')) return;
  try { await api("/api/admin/sites/" + encodeURIComponent(name), { method: "DELETE" }); toast("已删除", "success"); SELECTED.delete(name); await loadSites(); } catch (e) { toast(e.message, "error"); }
}
async function batchDelete() {
  if (!confirm("确认删除选中的 " + SELECTED.size + " 个站点？")) return;
  try { await api("/api/admin/sites/batch", { method: "POST", body: JSON.stringify({ action: "delete", names: [...SELECTED] }) }); toast("批量删除完成", "success"); SELECTED.clear(); await loadSites(); } catch (e) { toast(e.message, "error"); }
}
async function batchTag() {
  const tag = prompt("输入要添加的标签名称：");
  if (!tag) return;
  try { const data = await api("/api/admin/sites/batch", { method: "POST", body: JSON.stringify({ action: "add_tag", names: [...SELECTED], tag: tag.trim() }) }); toast("已为 " + data.affected + " 个站点添加标签", "success"); SELECTED.clear(); await loadSites(); } catch (e) { toast(e.message, "error"); }
}
async function toggleEnable(name, enabled) {
  try { const site = SITES.find((s) => s.name === name); if (!site) return; await api("/api/admin/sites/" + encodeURIComponent(name), { method: "PUT", body: JSON.stringify({ ...site, enabled }) }); toast(enabled ? "已启用：" + name : "已停用：" + name, "success"); await loadSites(); } catch (e) { toast(e.message, "error"); }
}
async function batchEnable() {
  if (SELECTED.size === 0) return;
  try { const data = await api("/api/admin/sites/batch", { method: "POST", body: JSON.stringify({ action: "enable", names: [...SELECTED] }) }); toast("已启用 " + data.affected + " 个站点", "success"); SELECTED.clear(); await loadSites(); } catch (e) { toast(e.message, "error"); }
}
async function batchDisable() {
  if (SELECTED.size === 0) return;
  if (!confirm("确认停用选中的 " + SELECTED.size + " 个站点？")) return;
  try { const data = await api("/api/admin/sites/batch", { method: "POST", body: JSON.stringify({ action: "disable", names: [...SELECTED] }) }); toast("已停用 " + data.affected + " 个站点", "success"); SELECTED.clear(); await loadSites(); } catch (e) { toast(e.message, "error"); }
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
  if (tab === "health") loadDeadUrls();
  if (tab === "feedback") loadFeedbacks();
  if (tab === "schema") loadSchema();
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
      return '<div class="sub-card" id="sub-' + sub.id + '"><div class="sub-header"><span class="sub-name">' + esc(sub.site.name) + '</span><span class="sub-time">' + esc(time) + ' | ' + esc(sub.ip) + '</span></div><div class="sub-url">' + esc(sub.site.url) + '</div>' + (sub.site.summary ? '<div class="sub-summary">' + esc(sub.site.summary) + '</div>' : '') + (tags ? '<div style="margin-top:4px">' + tags + '</div>' : '') + '<div class="sub-actions"><button class="btn btn-sm btn-primary" data-id="' + esc(sub.id) + '" data-action="approve-submission">✅ 批准</button> <button class="btn btn-sm btn-danger" data-id="' + esc(sub.id) + '" data-action="reject-submission">❌ 驳回</button></div></div>';
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
  if (!confirm("确认驳回此提交？")) return;
  try { await api("/api/admin/sites/batch", { method: "POST", body: JSON.stringify({ action: "reject_submission", id }) }); toast("已驳回", "success"); await loadSubmissions(); } catch (e) { toast(e.message, "error"); }
}
// 恢复死链 = 启用站点（走 /api/admin/sites/batch 的 enable，写人工验证时间）
// 这是"可用/死链"二元模型的唯一状态入口：健康扫描对账报告里的
// "标记为死链"/"恢复为可用"按钮都走这里，站点表的"启用"开关也走这里。
async function setDeadByName(name, isDead) {
  try {
    const data = await api("/api/admin/sites/batch", { method: "POST", body: JSON.stringify({ action: isDead ? "disable" : "enable", names: [name] }) });
    toast(isDead ? "已标记为死链：" + name : "已恢复为可用：" + name, "success");
    await loadSites();
  } catch (e) { toast(e.message, "error"); }
}
/**
 * 共享的健康扫描逻辑（链接健康 tab 和站点管理 tab 共用） '</span></span><span style="width:150px;color:var(--muted);font-size:11px">' + deadFreshness(s) + '</span><button class="btn btn-sm btn-primary" data-name="' + esc(s.name) + '" data-action="restore-dead">恢复</button></div>';
  }).join("");
}
function toggleDeadSelect(name, checked) { if (checked) DEAD_SELECTED.add(name); else DEAD_SELECTED.delete(name); updateDeadBatchBar(); }
function toggleDeadSelectAll(checked) { document.querySelectorAll('#deadUrlsList input[data-action="toggle-dead-select"]').forEach((cb) => { cb.checked = checked; const name = cb.getAttribute("data-name"); if (checked) DEAD_SELECTED.add(name); else DEAD_SELECTED.delete(name); }); updateDeadBatchBar(); }
function clearDeadSelection() { DEAD_SELECTED.clear(); document.getElementById("deadSelectAll").checked = false; document.querySelectorAll('#deadUrlsList input[data-action="toggle-dead-select"]').forEach((cb) => cb.checked = false); updateDeadBatchBar(); }
function updateDeadBatchBar() { const bar = document.getElementById("deadBatchBar"); const count = DEAD_SELECTED.size; document.getElementById("deadBatchCount").textContent = count; bar.classList.toggle("active", count > 0); }
// 恢复死链 = 启用站点（走 /api/admin/sites/batch 的 enable，写人工验证时间）
async function setDeadByName(name, isDead) {
  try {
    const data = await api("/api/admin/sites/batch", { method: "POST", body: JSON.stringify({ action: isDead ? "disable" : "enable", names: [name] }) });
    toast(isDead ? "已标记为死链：" + name : "已恢复为可用：" + name, "success");
    await loadSites(); loadDeadUrls();
  } catch (e) { toast(e.message, "error"); }
}
async function batchRestoreDead() {
  if (DEAD_SELECTED.size === 0) return;
  try { const data = await api("/api/admin/sites/batch", { method: "POST", body: JSON.stringify({ action: "enable", names: [...DEAD_SELECTED] }) }); toast("已恢复 " + data.affected + " 个站点为可用", "success"); DEAD_SELECTED.clear(); await loadSites(); loadDeadUrls(); } catch (e) { toast(e.message, "error"); }
}
async function restoreDeadUrl(name) {
  await setDeadByName(name, false);
}
// 一键恢复全部死链
async function restoreAllDeadUrls() {
  const dead = SITES.filter((s) => s.dead);
  if (dead.length === 0) { toast("当前没有死链站点", "info"); return; }
  if (!confirm("确认恢复全部 " + dead.length + " 个死链站点为可用？")) return;
  try {
    const names = dead.map((s) => s.name);
    const data = await api("/api/admin/sites/batch", { method: "POST", body: JSON.stringify({ action: "enable", names }) });
    toast("已恢复 " + data.affected + " 个站点为可用", "success");
    DEAD_SELECTED.clear();
    await loadSites(); loadDeadUrls();
  } catch (e) { toast(e.message, "error"); }
}
/**
 * 共享的健康扫描逻辑（链接健康 tab 和站点管理 tab 共用）
 * @param {object} opts
 * @param {function} opts.onProgress — 进度回调 (msg) => void
 * @param {function} opts.onResult — 扫描完成回调 ({ alive, dead, allNewDead, allResults }) => void
 */
async function runHealthScan({ onProgress, onResult }) {
  // 必须与 worker/src/health.js 的 HEALTH_BATCH_SIZE 一致。
  // 服务端会硬截断并在响应里回传 maxBatch，下面做漂移检测——
  // 万一两边不一致，宁可报出来也不要静默丢掉后半批 URL。
  let BATCH_SIZE = 20;
  const allUrls = SITES.map(s => s.url).filter(Boolean);
  if (allUrls.length === 0) { onProgress("没有可检查的站点"); return; }
  const allResults = [];
  const allNewDead = [];
  let i = 0;
  let batchIdx = 0;
  while (i < allUrls.length) {
    batchIdx++;
    const totalBatches = Math.ceil(allUrls.length / BATCH_SIZE);
    onProgress("正在检查... 批次 " + batchIdx + "/" + totalBatches + "（" + Math.min(i + BATCH_SIZE, allUrls.length) + "/" + allUrls.length + "）");
    const data = await api("/api/admin/check-batch", { method: "POST", body: JSON.stringify({ urls: allUrls.slice(i, i + BATCH_SIZE) }) });
    allResults.push(...data.results);
    if (data.newDeadUrls && data.newDeadUrls.length > 0) allNewDead.push(...data.newDeadUrls);
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
  onResult({ alive, dead, allNewDead, allResults });
}

async function batchCheckUrls() {
  const statusEl = document.getElementById("healthStatus"); const resultsEl = document.getElementById("healthResults");
  statusEl.textContent = "正在检查中，请稍候..."; resultsEl.innerHTML = "";
  try {
    await runHealthScan({
      onProgress: (msg) => { statusEl.textContent = msg; },
      onResult: ({ alive, dead, allResults }) => {
        statusEl.textContent = "扫描完成：共 " + allResults.length + " 个 URL，" + alive + " 可达，" + dead + " 不可达（仅记录证据，不自动改状态）";
        // 对账报告：扫描结果 × 站点当前可用性
        var byUrl = {};
        SITES.forEach(function(s) { byUrl[s.url] = s; });
        var unreachEnabled = [];  // 不可达 + 当前启用 → 需要标记死链
        var unreachDisabled = []; // 不可达 + 当前禁用 → 已在死链
        var reachDisabled = [];   // 可达 + 当前禁用 → 可能已恢复
        var reachEnabled = [];    // 可达 + 当前启用 → 正常
        allResults.forEach(function(r) {
          var s = byUrl[r.url];
          var isEnabled = s ? s.enabled !== false : true;
          if (r.ok) { if (isEnabled) reachEnabled.push(r); else reachDisabled.push(r); }
          else { if (isEnabled) unreachEnabled.push(r); else unreachDisabled.push(r); }
        });
        var html = "";
        if (unreachEnabled.length > 0) {
          html += '<div style="margin-bottom:10px"><strong style="color:var(--coral)">\u26a1 \u4e0d\u53ef\u8fbe\u4f46\u5f53\u524d\u53ef\u7528\uff08\u5efa\u8bae\u6807\u8bb0\u4e3a\u6b7b\u94fe\uff09(' + unreachEnabled.length + ')</strong></div>';
          html += unreachEnabled.map(function(r) {
            var s = byUrl[r.url];
            return '<div style="display:flex;align-items:center;gap:8px;padding:4px 8px;font-size:12px;border-bottom:1px solid var(--line)">' +
              '<span style="flex:1;word-break:break-all"><a href="' + esc(r.url) + '" target="_blank">' + esc(s.name) + '</a> <span style="color:var(--muted)">' + esc(r.url) + '</span></span>' +
              '<span style="color:var(--coral);white-space:nowrap">' + esc(r.error || ("HTTP " + r.status)) + '</span>' +
              '<button class="btn btn-sm btn-danger" data-name="' + esc(s.name) + '" data-action="mark-dead">\u6807\u8bb0\u4e3a\u6b7b\u94fe</button></div>';
          }).join("");
        }
        if (reachDisabled.length > 0) {
          html += '<div style="margin:12px 0 10px"><strong style="color:var(--teal)">\ud83d\udd04 \u5df2\u53ef\u8fbe\u4f46\u5f53\u524d\u4e3a\u6b7b\u94fe\uff08\u5efa\u8bae\u6062\u590d\u4e3a\u53ef\u7528\uff09(' + reachDisabled.length + ')</strong></div>';
          html += reachDisabled.map(function(r) {
            var s = byUrl[r.url];
            return '<div style="display:flex;align-items:center;gap:8px;padding:4px 8px;font-size:12px;border-bottom:1px solid var(--line)">' +
              '<span style="flex:1;word-break:break-all"><a href="' + esc(r.url) + '" target="_blank">' + esc(s.name) + '</a> <span style="color:var(--muted)">' + esc(r.url) + '</span></span>' +
              '<span style="color:var(--teal);white-space:nowrap">HTTP ' + r.status + '</span>' +
              '<button class="btn btn-sm btn-primary" data-name="' + esc(s.name) + '" data-action="restore-dead">\u6062\u590d\u4e3a\u53ef\u7528</button></div>';
          }).join("");
        }
        html += '<div style="margin:12px 0 4px;color:var(--muted);font-size:12px">\u5df2\u4e00\u81f4\uff08\u65e0\u9700\u64cd\u4f5c\uff09\uff1a\u4e0d\u53ef\u8fbe\u4e14\u5df2\u6807\u8bb0\u6b7b\u94fe ' + unreachDisabled.length + ' \u4e2a\uff1b\u53ef\u8fbe\u4e14\u53ef\u7528 ' + reachEnabled.length + ' \u4e2a\u3002</div>';
        resultsEl.innerHTML = html; loadSites().then(loadDeadUrls);
      },
    });
  } catch (e) { statusEl.textContent = "检查失败: " + e.message; }
}
// ── 站点管理 tab 一键清理死链 ──────────────────────────────────────────────
async function sitesCleanupDeadLinks() {
  var statusEl = document.getElementById("sitesCleanStatus");
  if (SITES.length === 0) { toast("请先加载站点列表", "error"); return; }
  if (!confirm("将检查全部 " + SITES.length + " 个站点的 URL 可达性，结果支持一键标记/恢复。确认继续？")) return;
  statusEl.textContent = "正在检查中...";
  try {
    await runHealthScan({
      onProgress: (msg) => { statusEl.textContent = msg; },
      onResult: ({ alive, dead, allResults }) => {
        var byUrl = {};
        SITES.forEach(function(s) { byUrl[s.url] = s; });
        var unreachEnabled = 0, reachDisabled = 0;
        allResults.forEach(function(r) {
          var s = byUrl[r.url];
          var isEnabled = s ? s.enabled !== false : true;
          if (r.ok) { if (!isEnabled) reachDisabled++; }
          else { if (isEnabled) unreachEnabled++; }
        });
        var msg = "检查完成：" + alive + " 正常，" + dead + " 不可达";
        if (unreachEnabled > 0) msg += "（" + unreachEnabled + " 个待标记死链）";
        if (reachDisabled > 0) msg += "（" + reachDisabled + " 个待恢复）";
        if (unreachEnabled > 0 || reachDisabled > 0) msg += "，请切换到链接健康标签页查看详情及操作。";
        statusEl.textContent = msg;
        toast(msg, (unreachEnabled > 0 || reachDisabled > 0) ? "info" : "success");
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
    if (feedbacks.length === 0) { list.innerHTML = '<div style="color:var(--muted);padding:20px;text-align:center">暂无反馈</div>'; return; }
    var typeColors = { error: "var(--coral)", correction: "var(--amber)", positive: "var(--teal)" };
    var typeLabels = { error: "报错", correction: "纠正", positive: "好评" };
    var statusLabels = { new: "🆕 待处理", read: "👁️ 已读", resolved: "✅ 已解决" };
    list.innerHTML = feedbacks.map(function(f) {
      var time = fmtTime(f.createdAt);
      var statusStyle = f.status === "new" ? "font-weight:700" : "color:var(--muted)";
      var typeStyle = "background:" + (typeColors[f.type] || "var(--tag-bg)") + ";color:#fff";
      return '<div class="sub-card" style="border-left:3px solid ' + (typeColors[f.type] || "var(--line)") + '">' +
        '<div class="sub-header"><span class="sub-name">' + esc(f.siteName) + '</span>' +
        '<span class="sub-time">' + esc(time) + ' | ' + esc(f.ip) + '</span></div>' +
        '<div style="margin:4px 0"><span class="tag" style="' + typeStyle + '">' + esc(typeLabels[f.type] || f.type) + '</span> ' +
        '<span style="' + statusStyle + ';font-size:12px">' + esc(statusLabels[f.status] || f.status) + '</span></div>' +
        '<div class="sub-summary" style="white-space:normal">' + esc(f.content) + '</div>' +
        '<div class="sub-actions">' +
        (f.status !== "read" ? '<button class="btn btn-sm" data-fb-id="' + f.id + '" data-fb-action="read" data-action="fb-action">👁️ 标记已读</button> ' : '') +
        (f.status !== "resolved" ? '<button class="btn btn-sm btn-primary" data-fb-id="' + f.id + '" data-fb-action="resolved" data-action="fb-action">✅ 已解决</button> ' : '') +
        '<button class="btn btn-sm btn-danger" data-fb-id="' + f.id + '" data-fb-action="delete" data-action="fb-action">🗑️ 删除</button>' +
        '</div></div>';
    }).join("");
  } catch (e) { toast("加载反馈失败: " + e.message, "error"); }
}
async function feedbackAction(id, action) {
  if (action === "delete" && !confirm("确认删除此反馈？")) return;
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
  fetch("/api/admin/export", { headers: { "Authorization": "Bearer " + TOKEN } }).then(function(res) { if (!res.ok) { toast("导出失败: " + res.status, "error"); return; } return res.text(); }).then(function(text) { if (!text) return; var blob = new Blob([text], { type: "application/json" }); var url = URL.createObjectURL(blob); var a = document.createElement("a"); a.href = url; a.download = "sites-export.json"; a.click(); URL.revokeObjectURL(url); toast("导出成功"); }).catch(function() { toast("网络错误", "error"); });
}
let IMPORT_DATA = null;
function showImport() { IMPORT_DATA = null; document.getElementById("importFile").value = ""; document.getElementById("importPreview").style.display = "none"; document.getElementById("importBtn").disabled = true; document.getElementById("importOverwrite").checked = false; document.getElementById("importModal").classList.add("active"); }
function closeImportModal() { document.getElementById("importModal").classList.remove("active"); IMPORT_DATA = null; }
function previewImport(input) {
  const file = input.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => { try { const raw = JSON.parse(e.target.result); let sites = Array.isArray(raw) ? raw : (raw.sites || []); sites = sites.filter((s) => s && s.name && s.url); if (sites.length === 0) { toast("未找到有效站点数据", "error"); return; } IMPORT_DATA = sites; document.getElementById("importCount").textContent = sites.length; const preview = sites.slice(0, 10).map((s) => { let line = "• " + s.name; if (s.url) line += " → " + s.url.slice(0, 50) + (s.url.length > 50 ? "..." : ""); return line; }).join("\\n"); document.getElementById("importPreviewText").value = preview + (sites.length > 10 ? "\\n... 共 " + sites.length + " 条" : ""); document.getElementById("importPreview").style.display = "block"; document.getElementById("importBtn").disabled = false; } catch (err) { toast("JSON 解析失败: " + err.message, "error"); } };
  reader.readAsText(file);
}
async function doImport() {
  if (!IMPORT_DATA || IMPORT_DATA.length === 0) { toast("无数据可导入", "error"); return; }
  const overwrite = document.getElementById("importOverwrite").checked; document.getElementById("importBtn").disabled = true;
  try { const data = await api("/api/admin/sites/import", { method: "POST", body: JSON.stringify({ sites: IMPORT_DATA, overwrite }) }); let msg = "导入完成：新增 " + data.added + " 条"; if (data.updated) msg += "，更新 " + data.updated + " 条"; if (data.skipped) msg += "，跳过 " + data.skipped + " 条"; if (data.duplicates && data.duplicates.length > 0) msg += "\\n重复站点：" + data.duplicates.map((d) => d.existingName).join(", "); toast(msg, "success"); closeImportModal(); await loadSites(); } catch (e) { toast(e.message, "error"); document.getElementById("importBtn").disabled = false; }
}
function toast(msg, type) { const el = document.getElementById("toast"); el.textContent = msg; el.className = "toast " + type + " show"; setTimeout(() => el.classList.remove("show"), 3000); }
if (TOKEN) { loadSites().then(() => { document.getElementById("loginView").style.display = "none"; document.getElementById("mainView").style.display = "block"; }).catch(() => { TOKEN = ""; localStorage.removeItem("sk-free-admin-token"); }); }
document.addEventListener("click", function(e) {
  var el = e.target.closest("[data-action]"); if (!el) return;
  var action = el.getAttribute("data-action"); var name = el.getAttribute("data-name") || ""; var id = el.getAttribute("data-id") || "";
  switch (action) {
    case "toggle-select":    toggleSelect(name, el.checked); break;
    case "toggle-enable":    toggleEnable(name, el.checked); break;
    case "show-edit":        showEdit(name); break;
    case "delete-site":      deleteSite(name); break;
    case "approve-submission": approveSubmission(id); break;
    case "reject-submission":  rejectSubmission(id); break;
    case "restore-dead":     restoreDeadUrl(name); break;
    case "mark-dead":        setDeadByName(name, true); break;
    case "toggle-dead-select-all": toggleDeadSelectAll(el.checked); break;
    case "fb-action":         feedbackAction(el.getAttribute("data-fb-id"), el.getAttribute("data-fb-action")); break;
  }
});
document.addEventListener("change", function(e) {
  var el = e.target.closest("[data-action]"); if (!el) return;
  var action = el.getAttribute("data-action"); var name = el.getAttribute("data-name") || "";
  if (action === "toggle-select") toggleSelect(name, el.checked);
  if (action === "toggle-enable") toggleEnable(name, el.checked);
  if (action === "toggle-dead-select") toggleDeadSelect(el.getAttribute("data-name"), el.checked);
});
</script>
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Worker 入口 — 路由分发
// ═══════════════════════════════════════════════════════════════════════════════

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      // CORS 预检
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(request) });
      }

      const kv = env.SKFREE_KV;
      const db = getDb(env);

      // ── Broadcast 首页 ─────────────────────────────────────
      if (path === "/" && request.method === "GET") {
        return new Response(broadcastHtml, {
          headers: { "Content-Type": "text/html;charset=utf-8", ...corsHeaders(request) },
        });
      }

      // ── 公告接口（从 KV 读取）──────────────────────────────
      if (path === "/api/notice" && request.method === "GET") {
        const notice = await kv.get("notice.md");
        return json({ ok: true, notice: notice || "" }, 200, request);
      }

      // ── 管理页面 ───────────────────────────────────────────
      if (path === "/admin" && request.method === "GET") {
        return html(getAdminHTML());
      }

      // ── 管理 API（需认证）──────────────────────────────────
      if (path.startsWith("/api/admin")) {
        const authError = requireAuth(request, env);
        if (authError) return authError;

        // 管理 API 速率限制（基于 IP 滑动窗口）
        cleanupAdminRateMap();
        const rateLimit = checkAdminRateLimit(request);
        if (rateLimit) {
          return json({ ok: false, error: `管理 API 请求过于频繁，请 ${rateLimit.retryAfter} 秒后再试` }, 429, request);
        }

        // POST /api/admin/sites/import — 批量导入（智能解析 URL）
        if (path === "/api/admin/sites/import" && request.method === "POST") {
          return handleAdminImportSites(db, request);
        }

        // GET /api/admin/sites
        if (path === "/api/admin/sites" && request.method === "GET") {
          return handleAdminListSites(db, request);
        }
        // POST /api/admin/sites
        if (path === "/api/admin/sites" && request.method === "POST") {
          return handleAdminCreateSite(db, request, kv);
        }
        // POST /api/admin/sites/batch
        if (path === "/api/admin/sites/batch" && request.method === "POST") {
          const batchBody = await request.clone().json().catch(() => ({}));
          if (batchBody.action === "approve_submission" || batchBody.action === "reject_submission") {
            const result = await handleAdminSubmissionAction(db, batchBody.action, batchBody.id);
            return json(result, result.ok ? 200 : (result.error === "提交不存在" ? 404 : 400), request);
          }
          return handleAdminBatch(db, request);
        }
        // GET /api/admin/export
        if (path === "/api/admin/export" && request.method === "GET") {
          return handleAdminExport(db, request);
        }
        // GET /api/admin/submissions
        if (path === "/api/admin/submissions" && request.method === "GET") {
          const result = await handleAdminGetSubmissions(db);
          return json(result, 200, request);
        }
        // POST /api/admin/submissions/:id/approve — 原子批准（建站+标记，M6）
        // 取代原来前端"先建站再标记批准"的两步流程（中间失败会留半完成状态）
        const approveMatch = path.match(/^\/api\/admin\/submissions\/([^/]+)\/approve$/);
        if (approveMatch && request.method === "POST") {
          const result = await handleAdminApproveSubmission(db, decodeURIComponent(approveMatch[1]));
          const status = !result.ok
            ? (result.error === "提交不存在或已处理" ? 404 : 409)
            : 201;
          return json(result, status, request);
        }
        // PUT /api/admin/sites/:name
        const putMatch = path.match(/^\/api\/admin\/sites\/(.+)$/);
        if (putMatch && request.method === "PUT") {
          return handleAdminUpdateSite(db, request, decodeURIComponent(putMatch[1]));
        }
        // DELETE /api/admin/sites/:name
        if (putMatch && request.method === "DELETE") {
          return handleAdminDeleteSite(db, request, decodeURIComponent(putMatch[1]));
        }

        // ── Dead URLs ─────────────────────────────────────────

        // GET /api/admin/dead-urls
        if (path === "/api/admin/dead-urls" && request.method === "GET") {
          const deadUrls = await getDeadUrls(db);
          return json({ ok: true, deadUrls }, 200, request);
        }
        // POST /api/admin/dead-urls — 添加/移除单条死链接
        if (path === "/api/admin/dead-urls" && request.method === "POST") {
          const parsed = await parseJsonBody(request);
          if (!parsed.ok) return parsed.response;
          const { url: deadUrl, action } = parsed.data;
          if (!deadUrl || !action) return json({ ok: false, error: "需要 url 和 action 参数" }, 400, request);
          if (action === "add") {
            await addDeadUrl(db, deadUrl, { reason: "unreachable" });
          } else if (action === "remove") {
            await removeDeadUrl(db, deadUrl);
          } else {
            return json({ ok: false, error: "action 只能是 add 或 remove" }, 400, request);
          }
          const deadUrls = await getDeadUrls(db);
          return json({ ok: true, count: Object.keys(deadUrls).length }, 200, request);
        }
        // POST /api/admin/dead-urls/batch — 批量添加/移除死链接
        if (path === "/api/admin/dead-urls/batch" && request.method === "POST") {
          const parsed = await parseJsonBody(request);
          if (!parsed.ok) return parsed.response;
          const { urls, action = "remove" } = parsed.data;
          if (!Array.isArray(urls) || urls.length === 0) {
            return json({ ok: false, error: "需要 urls 数组" }, 400, request);
          }
          const { changed } = await batchDeadUrls(db, urls, action);
          const deadUrls = await getDeadUrls(db);
          return json({ ok: true, changed, action, count: Object.keys(deadUrls).length }, 200, request);
        }

        // ── Health Check ──────────────────────────────────────

        // POST /api/admin/check-url — 检查单个 URL
        if (path === "/api/admin/check-url" && request.method === "POST") {
          const parsed = await parseJsonBody(request);
          if (!parsed.ok) return parsed.response;
          const { url: checkUrl } = parsed.data;
          if (!checkUrl) return json({ ok: false, error: "需要 url 参数" }, 400, request);
          const result = await checkUrlHealth(checkUrl);
          return json({ ok: true, url: checkUrl, ...result }, 200, request);
        }
        // POST /api/admin/check-batch — 批量检查 URL 健康状态
        // body: { urls: string[] } — 必传，由前端分页调用（每批 ≤45）
        if (path === "/api/admin/check-batch" && request.method === "POST") {
          const parsed = await parseJsonBody(request);
          if (!parsed.ok) return parsed.response;
          const urls = parsed.data.urls;
          if (!Array.isArray(urls) || urls.length === 0) {
            return json({ ok: false, error: "需要 urls 数组" }, 400, request);
          }
          // 超时 8 秒：1.5 秒太短导致大量合法站点误判为死链
          const result = await checkBatchHealth(db, urls, 8000);
          return json(result, 200, request);
        }

        // ── Feedbacks ─────────────────────────────────────────

        // GET /api/admin/feedbacks — 获取反馈列表（admin 专用）
        if (path === "/api/admin/feedbacks" && request.method === "GET") {
          const status = url.searchParams.get("status") || undefined;
          const result = await handleGetFeedbacks(db, status);
          return json(result, 200, request);
        }
        // POST /api/admin/feedbacks/:id — 处理反馈（标记已读/已解决/删除）
        const fbMatch = path.match(/^\/api\/admin\/feedbacks\/(\d+)$/);
        if (fbMatch && request.method === "POST") {
          const parsed = await parseJsonBody(request);
          if (!parsed.ok) return parsed.response;
          const result = await handleFeedbackAction(db, parseInt(fbMatch[1]), parsed.data.action);
          return json(result, result.ok ? 200 : 400, request);
        }

        // ── Schema ────────────────────────────────────────────

        // GET /api/admin/schema
        if (path === "/api/admin/schema" && request.method === "GET") {
          const schema = await getSchema(kv);
          return json({ ok: true, schema }, 200, request);
        }
        // PUT /api/admin/schema — 更新 Schema（全量替换）
        if (path === "/api/admin/schema" && request.method === "PUT") {
          const parsed = await parseJsonBody(request);
          if (!parsed.ok) return parsed.response;
          const newSchema = parsed.data;
          if (!newSchema.fields || !Array.isArray(newSchema.fields)) {
            return json({ ok: false, error: "schema 必须包含 fields 数组" }, 400, request);
          }
          for (const f of newSchema.fields) {
            if (!f.key || !f.label || !f.type) {
              return json({ ok: false, error: `字段缺少必填属性 (key/label/type): ${JSON.stringify(f)}` }, 400, request);
            }
            const validTypes = ["text", "url", "textarea", "number", "tags", "list", "select", "boolean", "date", "rating"];
            if (!validTypes.includes(f.type)) {
              return json({ ok: false, error: `字段类型无效: ${f.type}，支持: ${validTypes.join(", ")}` }, 400, request);
            }
          }
          const merged = {
            ...DEFAULT_SCHEMA, ...newSchema, fields: newSchema.fields,
            tags: newSchema.tags || DEFAULT_SCHEMA.tags,
            display: { ...DEFAULT_SCHEMA.display, ...(newSchema.display || {}) },
            submit: { ...DEFAULT_SCHEMA.submit, ...(newSchema.submit || {}) },
            healthCheck: { ...DEFAULT_SCHEMA.healthCheck, ...(newSchema.healthCheck || {}) },
            theme: { ...DEFAULT_SCHEMA.theme, ...(newSchema.theme || {}) }
          };
          await saveSchema(kv, merged);
          return json({ ok: true, schema: merged }, 200, request);
        }

        return json({ ok: false, error: "Not Found" }, 404, request);
      }

      // ── 公开 API ───────────────────────────────────────────

      // GET /api/schema
      if (path === "/api/schema" && request.method === "GET") {
        const schema = await getSchema(kv);
        return json({ ok: true, schema }, 200, request);
      }

      // GET /api/sites — 仅返回已启用站点
      if (path === "/api/sites" && request.method === "GET") {
        const data = await handleGetEnabledSites(db);
        return json(data, 200, request);
      }

      // POST /api/submit — 用户提交新站点
      if (path === "/api/submit" && request.method === "POST") {
        return handleSubmitSite(request, db);
      }

      // POST /api/feedback — 用户提交反馈（报错/纠正/好评）
      if (path === "/api/feedback" && request.method === "POST") {
        return handleSubmitFeedback(request, db);
      }

      // GET /api/votes
      if (path === "/api/votes" && request.method === "GET") {
        const data = await handleGetVotes(db);
        return json(data, 200, request);
      }

      // POST /api/vote
      if (path === "/api/vote" && request.method === "POST") {
        return handleVote(request, db);
      }

      // GET /api/health
      if (path === "/api/health") {
        return json({ ok: true, timestamp: Date.now() }, 200, request);
      }

      // 404
      return json({ ok: false, error: "Not Found" }, 404, request);

    } catch (e) {
      // M2 修复：此前把 e.message 原样回传（"Internal error: <细节>"），
      // SQL/堆栈/路径等内部结构可被攻击者侦察。生产环境返回固定文案，
      // 细节只进日志。
      console.error("Unhandled error:", e && e.stack ? e.stack : e);
      return json({ ok: false, error: "服务器内部错误，请稍后重试" }, 500, request);
    }
  },

  // ── Cron Trigger：定时健康检查 ────────────────────────────────────────────
  // 每6小时自动检查所有启用站点的 URL 可达性
  // 写入 verified_at/verified_by 字段，为前端鲜度可视化提供数据
  // 设计：失败绝不自动下线（概率性探测不驱动不可逆动作），
  //       只累计 health_fail_count 供管理员判断，成功则清零。
  async scheduled(event, env, ctx) {
    const db = getDb(env);
    try {
      // ── 每次 cron 只检查一个"预算安全"的切片，绝不遍历全表 ──────────────────
      //
      // 50 个 subrequest 的上限是**每次调用**的，不是每批次的。原来的写法是
      //   for (i = 0; i < sites.length; i += 20)
      // 把全表分批跑完 —— 批次只限制并发，不限制单次调用的总量。
      // 实测（stub fetch 计数，忠实复刻本循环，最坏情况即所有 HEAD 都失败、
      // 每个 URL 消耗 2 个 fetch）：
      //   18 站 → 38 subreq ✅    22 站 → 47 ✅    23 站 → 49 ✅
      //   24 站 → 51 ❌           30 站 → 63 ❌    40 站 → 83 ❌
      // 也就是说站点数一过 23，cron 就会 1101 整体失败，verified_at 一次都写
      // 不进去，前端鲜度永远显示"未验证" —— 正是之前已经踩过的那个坑，
      // 只是当时的触发条件是批次太大，这次的触发条件是站点变多。
      // 线上现在 18 个站，离 23 只剩 5 个的余量，属于随时会炸。
      //
      // 切片怎么选：
      //   前一半额度给"从未验证过的"（verified_at IS NULL），其中优先检查
      //   历史检查次数最少的（health_fail_count 小），保证同组内轮转；
      //   剩下的额度给"验证时间最老的"。
      //   一半一半是为了防饿死：如果只按"从未验证优先"，一旦长期失效的站点
      //   攒到 20 个以上，它们会永久占满整个切片，健康站点再也不会被复验，
      //   所有人的鲜度一起烂掉。
      const BATCH = HEALTH_BATCH_SIZE;
      // Math.max(1, …)：万一有人把 HEALTH_BATCH_SIZE 调成 1，floor(1/2)=0 会让
      // "从未验证"这一组永远拿不到额度，新站点的鲜度永远写不进去。
      const HALF = Math.max(1, Math.floor(BATCH / 2));

      const never = await dbAll(
        db,
        `SELECT id, name, url FROM sites
          WHERE enabled = 1 AND url != '' AND verified_at IS NULL
          ORDER BY health_fail_count ASC, id ASC
          LIMIT ?`,
        [HALF]
      );
      const stale = await dbAll(
        db,
        `SELECT id, name, url FROM sites
          WHERE enabled = 1 AND url != '' AND verified_at IS NOT NULL
          ORDER BY verified_at ASC
          LIMIT ?`,
        [BATCH - never.length]
      );
      const batch = [...never, ...stale];
      if (batch.length === 0) return;

      // fallback 预算：每个 URL 先占 1 个 HEAD，剩余额度才允许 GET 复核。
      // 上面用了 2 次 SELECT，下面还有 1 次 dbBatch，共 3 个 subrequest，
      // 所以留给 fetch 的额度是 50-3=47；BATCH=20 时最坏 40 个 fetch，安全。
      const FETCH_BUDGET_HERE = 47;
      const fallbackQuota = Math.max(0, FETCH_BUDGET_HERE - batch.length);
      const deadline = Date.now() + 25000;
      const results = await Promise.all(
        batch.map(async (site, idx) => {
          const r = await checkUrlHealth(site.url, undefined, {
            allowFallback: idx < fallbackQuota,
            deadline,
          });
          return { ...site, ...r };
        })
      );

      const stmts = results.map((r) =>
        r.ok
          ? // 成功：更新验证时间并把失败计数清零
            db
              .prepare(
                "UPDATE sites SET verified_at = datetime('now'), verified_by = 'healthcheck', health_fail_count = 0 WHERE id = ?"
              )
              .bind(r.id)
          : // 失败：只累计计数，不动 enabled、不写 dead_urls。
            // 连续失败到多少次算"确认失效"由管理员看着计数决定。
            db
              .prepare(
                "UPDATE sites SET health_fail_count = health_fail_count + 1 WHERE id = ?"
              )
              .bind(r.id)
      );
      if (stmts.length > 0) {
        await dbBatch(db, stmts);
      }
      const checked = results.length;
      const alive = results.filter((r) => r.ok).length;

      // Cron 执行日志（Cloudflare Dashboard 可查看）。
      // 打出"本次检查 / 待检总数"，这样站点变多、单次覆盖不全时能立刻看出来，
      // 而不是等到用户发现鲜度不对。cron 每 6 小时一次 = 每天 4 轮，
      // 每轮最多 BATCH 个，全量扫完一遍需要 ceil(总数 / BATCH) 轮。
      const totalRow = await dbGet(
        db,
        "SELECT COUNT(*) AS n FROM sites WHERE enabled = 1 AND url != ''"
      );
      const total = totalRow?.n ?? checked;
      const rounds = Math.ceil(total / BATCH);
      console.log(
        `[cron] health check: ${checked}/${total} checked, ${alive} alive, ${checked - alive} dead` +
          (rounds > 1 ? `（全量扫完需 ${rounds} 轮，约 ${rounds * 6} 小时）` : "")
      );
    } catch (e) {
      console.error("[cron] health check failed:", e.message);
    }
  }
};
