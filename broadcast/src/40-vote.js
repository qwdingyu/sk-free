// ═══════════════════════════════════════════════════════════════════════════════
// 投票系统
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 从 localStorage 读取当前用户的投票记录
 * @returns {Object} { "站点名": "up" | "down" }
 */
function loadPersonalVotes() {
  try {
    return JSON.parse(localStorage.getItem(VOTE_STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

/**
 * 将用户的投票记录持久化到 localStorage
 */
function savePersonalVotes(votes) {
  try {
    localStorage.setItem(VOTE_STORAGE_KEY, JSON.stringify(votes));
  } catch {
    // localStorage 不可用时忽略（隐私模式等）
  }
}

/**
 * 处理用户点击投票按钮
 * 流程：前端校验 → API 请求 → 乐观更新 → 持久化
 */
async function handleVote(siteName, vote, voteBar) {
  const personalVotes = loadPersonalVotes();

  // 检查是否已对该站点投过票
  if (personalVotes[siteName]) {
    voteBar.classList.add("vote-flash");
    setTimeout(() => voteBar.classList.remove("vote-flash"), 600);
    return;
  }

  // 禁用按钮防止重复点击
  const buttons = voteBar.querySelectorAll(".vote-btn");
  buttons.forEach((b) => (b.disabled = true));

  try {
    const res = await fetch("/api/vote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ siteName: siteName, type: vote })
    });
    const data = await res.json();

    if (data.ok) {
      state.votes[siteName] = { up: data.up || 0, down: data.down || 0 };
      personalVotes[siteName] = vote;
      savePersonalVotes(personalVotes);
      refreshVoteBar(voteBar, siteName);
    } else if (res.status === 429) {
      voteBar.classList.add("vote-flash");
      setTimeout(() => voteBar.classList.remove("vote-flash"), 600);
      toast(data.error || "投票过于频繁，请稍后再试", "error");
    } else {
      toast(data.error || "投票失败", "error");
    }
  } catch {
    toast("网络错误，请稍后重试", "error");
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

/**
 * 刷新投票按钮组的视觉状态
 */
function refreshVoteBar(voteBar, siteName) {
  const personalVotes = loadPersonalVotes();
  const userVote = personalVotes[siteName] || null;
  const score = netVotes(siteName);

  const scoreEl = voteBar.querySelector(".vote-score");
  if (scoreEl) {
    scoreEl.textContent = score > 0 ? `+${score}` : String(score);
    scoreEl.className = "vote-score" + (score > 0 ? " positive" : score < 0 ? " negative" : "");
  }

  const upBtn = voteBar.querySelector("[data-vote='up']");
  const downBtn = voteBar.querySelector("[data-vote='down']");
  if (upBtn) {
    upBtn.classList.toggle("is-active", userVote === "up");
    upBtn.setAttribute("aria-pressed", String(userVote === "up"));
    upBtn.disabled = !!userVote;
  }
  if (downBtn) {
    downBtn.classList.toggle("is-active", userVote === "down");
    downBtn.setAttribute("aria-pressed", String(userVote === "down"));
    downBtn.disabled = !!userVote;
  }
}

/**
 * 构建投票按钮组 DOM 元素
 */
function makeVoteBar(siteName) {
  const bar = document.createElement("div");
  bar.className = "vote-bar";

  const personalVotes = loadPersonalVotes();
  const userVote = personalVotes[siteName] || null;
  const score = netVotes(siteName);

  const upBtn = document.createElement("button");
  upBtn.type = "button";
  upBtn.className = "vote-btn vote-up" + (userVote === "up" ? " is-active" : "");
  upBtn.setAttribute("aria-label", "支持");
  upBtn.setAttribute("aria-pressed", String(userVote === "up"));
  upBtn.textContent = "👍";
  upBtn.disabled = !!userVote;
  upBtn.addEventListener("click", () => handleVote(siteName, "up", bar));

  const scoreEl = document.createElement("span");
  scoreEl.className = "vote-score" + (score > 0 ? " positive" : score < 0 ? " negative" : "");
  scoreEl.textContent = score > 0 ? `+${score}` : String(score);

  const downBtn = document.createElement("button");
  downBtn.type = "button";
  downBtn.className = "vote-btn vote-down" + (userVote === "down" ? " is-active" : "");
  downBtn.setAttribute("aria-label", "不推荐");
  downBtn.setAttribute("aria-pressed", String(userVote === "down"));
  downBtn.textContent = "👎";
  downBtn.disabled = !!userVote;
  downBtn.addEventListener("click", () => handleVote(siteName, "down", bar));

  bar.append(upBtn, scoreEl, downBtn);
  return bar;
}
