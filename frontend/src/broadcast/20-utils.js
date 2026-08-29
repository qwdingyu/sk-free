// ═══════════════════════════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 数组去重并过滤空值
 */
function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

/**
 * 防抖：延迟执行，连续调用只执行最后一次
 * @param {Function} fn - 要防抖的函数
 * @param {number} ms - 延迟毫秒数
 * @returns {Function} 防抖后的函数
 */
function debounce(fn, ms) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

/**
 * 解析 D1 的时间字符串为毫秒时间戳
 *
 * D1 里所有时间都是 SQLite 的 datetime('now') 产物，格式为
 * "YYYY-MM-DD HH:MM:SS"，**内容是 UTC 但字符串里没有时区标记**。
 * 直接 new Date("2026-08-25 15:24:54") 会被当成本地时间：
 * 在 UTC+8 下实测偏差 8 小时 —— 刚验证过的站点显示"8小时前"，
 * 本该保持 24 小时的绿色鲜度只剩 16 小时。
 * 而且这个格式不是 ISO 8601，某些浏览器直接返回 Invalid Date → NaN。
 *
 * 所以必须补上 T 和 Z 再交给 Date 解析。
 *
 * @param {string} s - D1 时间字符串，或已带时区的 ISO 字符串
 * @returns {number} 毫秒时间戳；无法解析时返回 NaN
 */
function parseUtc(s) {
  if (!s) return NaN;
  if (typeof s === "number") return s;
  const str = String(s).trim();
  // 已经带时区信息（Z 或 ±HH:MM）就直接解析
  if (/[Zz]$/.test(str) || /[+-]\d{2}:?\d{2}$/.test(str)) return Date.parse(str);
  // "YYYY-MM-DD HH:MM:SS" → "YYYY-MM-DDTHH:MM:SSZ"
  const m = str.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/);
  if (m) return Date.parse(`${m[1]}T${m[2]}Z`);
  return Date.parse(str);
}

/**
 * 相对时间格式化（如 "2小时前"、"3天前"）
 * @param {string} isoStr - D1 时间字符串或 ISO 8601 字符串
 * @returns {string} 相对时间文本
 */
function relativeTime(isoStr) {
  if (!isoStr) return "";
  const ts = parseUtc(isoStr);
  if (Number.isNaN(ts)) return "";
  const diff = Date.now() - ts;
  // 允许 60 秒时钟偏差，超过此范围仍显示"刚刚"（比显示负数时间好）
  if (diff < -60000) return "刚刚";
  if (diff < 0) return "刚刚";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins}分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}天前`;
  const months = Math.floor(days / 30);
  return `${months}个月前`;
}

/**
 * 计算鲜度等级（绿/黄/灰/未验证）
 * @param {string} verifiedAt - D1 时间字符串
 * @returns {{ color: string, label: string, cls: string }}
 */
function freshnessLevel(verifiedAt) {
  if (!verifiedAt) return { color: "gray", label: "未验证", cls: "fresh-unknown" };
  const ts = parseUtc(verifiedAt);
  // 时间字段存在但解析不出来 → 说成"未验证"，不假装有鲜度
  if (Number.isNaN(ts)) return { color: "gray", label: "未验证", cls: "fresh-unknown" };
  const diff = Date.now() - ts;
  if (diff <= FRESH_24H)  return { color: "green", label: relativeTime(verifiedAt), cls: "fresh-green" };
  if (diff <= FRESH_7D)   return { color: "yellow", label: relativeTime(verifiedAt), cls: "fresh-yellow" };
  return { color: "stale", label: relativeTime(verifiedAt), cls: "fresh-stale" };
}

/**
 * 额度显示文本
 * @param {Object} site - 站点对象
 * @returns {string} 如 "25 刀/天"、"100 积分 ≈60次"、"额度未知"
 */
function quotaText(site) {
  // 必须用"是否为 null/undefined"判断，不能用真假值判断。
  // 0 是有效额度，null 才是未知，两者不能混。修复前的实测行为：
  //   min=null, max=50   → "null-50 积分/天"  ← 把 null 直接印给用户看
  //   min=0,    max=0    → "额度未知"         ← 明确填了 0 却当成没填
  //   min=0,    max=null → "额度未知"         ← 同上
  //   （min=0, max=50 这种区间修复前是对的，没有回归风险）
  // 管理后台加上结构化字段输入框之后，"只填上限"和"填 0"都能真填进来，
  // 这两条就会被踩到。
  const hasMin = site.quotaMin !== null && site.quotaMin !== undefined;
  const hasMax = site.quotaMax !== null && site.quotaMax !== undefined;

  if (site.quotaTier === "none" || (!hasMin && !hasMax)) {
    return site.quotaRaw || "额度未知";
  }
  const unit = QUOTA_UNIT_LABEL[site.quotaUnit] || site.quotaUnit || "";
  const period = site.quotaPeriod === "daily" ? "/天" : site.quotaPeriod === "once" ? "（一次性）" : "";
  let text = "";
  if (!hasMin) {
    // 只有上限：写成"最多 N"，别把缺失的下限印成 null
    text = `最多 ${site.quotaMax} ${unit}`;
  } else if (!hasMax || site.quotaMin === site.quotaMax) {
    text = `${site.quotaMin} ${unit}`;
  } else {
    text = `${site.quotaMin}-${site.quotaMax} ${unit}`;
  }
  if (site.quotaCallsEst) text += ` ≈${site.quotaCallsEst}次`;
  return text + period;
}

/**
 * 净票数
 */
function netVotes(siteName) {
  const v = state.votes[siteName];
  if (!v) return 0;
  return (v.up || 0) - (v.down || 0);
}

/**
 * 解析门槛文本为标签
 *
 * 本函数是**全函数**：任何输入都至少返回一个标签，绝不返回 []。
 * 这一点是契约，调用方依赖它：
 *   - 60-filter.js 的门槛筛选组用 thresholds.includes("无门槛") 判定
 *   - 80-view-card.js 用 thresholds[0] !== "无门槛" 决定是否显示门槛徽标
 *
 * 曾经第一行是 `if (!register) return []`，而后端 formatSiteRow 对缺失的
 * register 返回的正是 ""（不是 null）—— 于是"无门槛"标签只在 register 是
 * 纯空白串这种数据异常时才产生。后果是同一页面上两个都叫「无门槛」的入口
 * 结论相反：快捷视图 chip 自己判空（!s.register）能筛出来，而筛选面板的
 * 「无门槛」走本函数拿到 []，some() 恒假 → 勾选后列表直接清空，
 * 用户看到的是"一个站都不符合"，而不是本该出现的那批零门槛站点。
 *
 * @param {string} register - 注册要求文本（可能是 ""、null、undefined）
 * @returns {string[]} 至少一个标签，如 ["GitHub"]、["无门槛"]
 */
function parseThreshold(register) {
  // 统一成字符串再判断，把 ""/null/undefined 收敛到同一条路径
  const raw = typeof register === "string" ? register : "";
  const text = raw.toLowerCase();
  const tags = [];
  if (text.includes("github")) tags.push("GitHub");
  if (text.includes("telegram") || text.includes("tg")) tags.push("Telegram");
  if (text.includes("邮箱") || text.includes("email")) tags.push("邮箱");
  // 填了内容但识别不出具体渠道 → "其他"；真的没填 → "无门槛"
  if (tags.length === 0 && raw.trim()) tags.push("其他");
  if (tags.length === 0) tags.push("无门槛");
  return tags;
}
