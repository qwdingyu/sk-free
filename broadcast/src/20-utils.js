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
 * 相对时间格式化（如 "2小时前"、"3天前"）
 * @param {string} isoStr - ISO 8601 时间字符串
 * @returns {string} 相对时间文本
 */
function relativeTime(isoStr) {
  if (!isoStr) return "";
  const diff = Date.now() - new Date(isoStr).getTime();
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
 * @param {string} verifiedAt - ISO 时间字符串
 * @returns {{ color: string, label: string, cls: string }}
 */
function freshnessLevel(verifiedAt) {
  if (!verifiedAt) return { color: "gray", label: "未验证", cls: "fresh-unknown" };
  const diff = Date.now() - new Date(verifiedAt).getTime();
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
  if (site.quota_tier === "none" || (!site.quota_min && !site.quota_max)) {
    return site.quota_raw || "额度未知";
  }
  const unit = QUOTA_UNIT_LABEL[site.quota_unit] || site.quota_unit || "";
  const period = site.quota_period === "daily" ? "/天" : site.quota_period === "once" ? "（一次性）" : "";
  let text = "";
  if (site.quota_min === site.quota_max || !site.quota_max) {
    text = `${site.quota_min} ${unit}`;
  } else {
    text = `${site.quota_min}-${site.quota_max} ${unit}`;
  }
  if (site.quota_calls_est) text += ` ≈${site.quota_calls_est}次`;
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
 * @param {string} register - 注册要求文本
 * @returns {string[]} 如 ["GitHub", "Telegram"]
 */
function parseThreshold(register) {
  if (!register) return [];
  const text = register.toLowerCase();
  const tags = [];
  if (text.includes("github")) tags.push("GitHub");
  if (text.includes("telegram") || text.includes("tg")) tags.push("Telegram");
  if (text.includes("邮箱") || text.includes("email")) tags.push("邮箱");
  if (tags.length === 0 && register.trim()) tags.push("其他");
  if (tags.length === 0) tags.push("无门槛");
  return tags;
}
