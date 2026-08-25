// ═══════════════════════════════════════════════════════════════════════════════
// 主题系统（亮色/暗色/跟随系统）
// ═══════════════════════════════════════════════════════════════════════════════

const colorSchemeQuery =
  window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");

function getStoredTheme() {
  try {
    const value = localStorage.getItem(THEME_KEY) || "system";
    return THEME_CHOICES.includes(value) ? value : "system";
  } catch {
    return document.documentElement.dataset.themeChoice || "system";
  }
}

function resolveTheme(choice) {
  if (choice === "system") {
    return colorSchemeQuery && colorSchemeQuery.matches ? "dark" : "light";
  }
  return choice;
}

function applyTheme(choice, persist = false) {
  const safeChoice = THEME_CHOICES.includes(choice) ? choice : "system";
  document.documentElement.dataset.theme = resolveTheme(safeChoice);
  document.documentElement.dataset.themeChoice = safeChoice;

  els.themeButtons.forEach((button) => {
    const active = button.dataset.themeChoice === safeChoice;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });

  if (persist) {
    try {
      localStorage.setItem(THEME_KEY, safeChoice);
    } catch {
      // Storage can be unavailable in strict browser modes.
    }
  }
}

function initTheme() {
  els.themeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      applyTheme(button.dataset.themeChoice, true);
    });
  });

  if (colorSchemeQuery) {
    const handleChange = () => {
      if (getStoredTheme() === "system") applyTheme("system");
    };
    if (colorSchemeQuery.addEventListener) {
      colorSchemeQuery.addEventListener("change", handleChange);
    } else if (colorSchemeQuery.addListener) {
      colorSchemeQuery.addListener(handleChange);
    }
  }

  applyTheme(getStoredTheme());
}
