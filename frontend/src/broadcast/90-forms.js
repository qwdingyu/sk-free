// ═══════════════════════════════════════════════════════════════════════════════
// Toast 通知 + 提交表单 + 反馈系统
// ═══════════════════════════════════════════════════════════════════════════════

// ── Toast 通知（替代 9 处 alert）─────────────────────────────────────────────

/**
 * 显示 toast 通知
 * @param {string} msg - 提示文字
 * @param {string} type - "success" | "error" | "info"
 */
function toast(msg, type = "info") {
  // 移除已有 toast
  const existing = document.querySelector(".app-toast");
  if (existing) existing.remove();

  const el = document.createElement("div");
  el.className = `app-toast toast-${type}`;
  el.textContent = msg;
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  document.body.appendChild(el);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => el.classList.add("show"));
  });

  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 400);
  }, 3000);
}

// ── 快速反馈（表格行的 👍/👎 一键按钮）───────────────────────────────────────

const FEEDBACK_STORAGE_KEY = "sk-free-feedbacks";

function loadPersonalFeedbacks() {
  try {
    return JSON.parse(localStorage.getItem(FEEDBACK_STORAGE_KEY) || "{}");
  } catch { return {}; }
}

function savePersonalFeedbacks(record) {
  try { localStorage.setItem(FEEDBACK_STORAGE_KEY, JSON.stringify(record)); } catch {}
}

/**
 * 一键反馈（无需填文本，最低摩擦入口）
 * @param {string} siteName - 站点名称
 * @param {string} type - "still_works" | "reported_dead"
 */
async function quickFeedback(siteName, type) {
  const personalFeedbacks = loadPersonalFeedbacks();
  const key = `${siteName}:${type}`;
  if (personalFeedbacks[key]) {
    toast("您已反馈过该站点，感谢！", "info");
    return;
  }

  try {
    const res = await fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ siteName, type, content: "" })
    });
    const data = await res.json();
    if (data.ok) {
      personalFeedbacks[key] = true;
      savePersonalFeedbacks(personalFeedbacks);
      toast(type === "still_works" ? "👍 感谢确认！" : "👎 感谢已记录！", "success");
    } else {
      toast(data.error || "反馈失败", "error");
    }
  } catch {
    toast("网络错误，请稍后重试", "error");
  }
}

// ── 反馈模态框 ────────────────────────────────────────────────────────────────

function openFeedbackModal(siteName) {
  const modal = document.getElementById("feedbackModal");
  const nameEl = document.getElementById("feedbackSiteName");
  const contentEl = document.getElementById("feedbackContent");
  const typeGroup = document.getElementById("feedbackTypeGroup");
  const confirmBtn = document.getElementById("feedbackConfirmBtn");
  const charCount = document.getElementById("feedbackCharCount");

  if (!modal) return;

  // 重置表单
  nameEl.textContent = "站点：" + siteName;
  contentEl.value = "";
  charCount.textContent = "0";
  confirmBtn.disabled = false;
  confirmBtn.textContent = "提交反馈";
  modal.dataset.siteName = siteName;
  modal.dataset.feedbackType = "";

  typeGroup.querySelectorAll(".feedback-type-btn").forEach((btn) => {
    btn.classList.remove("is-active");
  });

  modal.showModal();
  contentEl.focus();
}

function initFeedbackForm() {
  const modal = document.getElementById("feedbackModal");
  const form = document.getElementById("feedbackForm");
  const typeGroup = document.getElementById("feedbackTypeGroup");
  const contentEl = document.getElementById("feedbackContent");
  const charCount = document.getElementById("feedbackCharCount");
  const confirmBtn = document.getElementById("feedbackConfirmBtn");

  if (!modal || !form) return;

  // 类型选择
  typeGroup.addEventListener("click", (e) => {
    const btn = e.target.closest(".feedback-type-btn");
    if (!btn) return;
    typeGroup.querySelectorAll(".feedback-type-btn").forEach((b) => b.classList.remove("is-active"));
    btn.classList.add("is-active");
    modal.dataset.feedbackType = btn.dataset.fbType;
  });

  // 字符计数
  contentEl.addEventListener("input", () => {
    charCount.textContent = String(contentEl.value.length);
  });

  // 提交
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const siteName = modal.dataset.siteName;
    const type = modal.dataset.feedbackType;
    const content = contentEl.value.trim();

    if (!type) { toast("请选择反馈类型", "error"); return; }
    if (content.length < 2) { toast("反馈内容至少需要 2 个字符", "error"); return; }

    // 与 quickFeedback 一致的 per-type 重复检测：同一站点同一类型只允许一次
    const personalFeedbacks = loadPersonalFeedbacks();
    if (personalFeedbacks[`${siteName}:${type}`]) {
      toast("您已反馈过该类型，感谢！", "info");
      return;
    }

    confirmBtn.disabled = true;
    confirmBtn.textContent = "提交中...";

    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteName, type, content })
      });
      const data = await res.json();
      if (data.ok) {
        modal.close();
        const personalFeedbacks = loadPersonalFeedbacks();
        personalFeedbacks[`${siteName}:${type}`] = true;
        savePersonalFeedbacks(personalFeedbacks);
        toast("✅ 感谢您的反馈！", "success");
      } else {
        toast(data.error || "提交失败", "error");
      }
    } catch {
      toast("网络错误，请稍后重试", "error");
    } finally {
      confirmBtn.disabled = false;
      confirmBtn.textContent = "提交反馈";
    }
  });
}

// ── 提交站点表单 ──────────────────────────────────────────────────────────────

function initSubmitForm() {
  const btn = document.getElementById("submitSiteBtn");
  const modal = document.getElementById("submitModal");
  const form = document.getElementById("submitForm");
  const confirmBtn = document.getElementById("submitConfirmBtn");

  if (!btn || !modal || !form) return;

  btn.addEventListener("click", () => {
    form.reset();
    modal.showModal();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    confirmBtn.disabled = true;
    confirmBtn.textContent = "提交中...";

    const body = {
      name: document.getElementById("submitName").value.trim(),
      url: document.getElementById("submitUrl").value.trim(),
      tags: document.getElementById("submitTags").value.split(",").map((t) => t.trim()).filter(Boolean),
      summary: document.getElementById("submitSummary").value.trim(),
      checkin: document.getElementById("submitCheckin").value.trim() || undefined,
      models: document.getElementById("submitModels").value.trim() || undefined,
      register: document.getElementById("submitRegister").value.trim() || undefined
    };

    try {
      const res = await fetch("/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (data.ok) {
        modal.close();
        toast("✅ " + (data.message || "提交成功，等待管理员审核"), "success");
      } else {
        toast(data.error || "提交失败", "error");
      }
    } catch {
      toast("网络错误，请稍后重试", "error");
    } finally {
      confirmBtn.disabled = false;
      confirmBtn.textContent = "提交审核";
    }
  });
}
