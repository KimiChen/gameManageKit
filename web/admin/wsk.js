/*
 * Adapted from Web Standard Kit at:
 * https://github.com/KimiChen/wheels/tree/f920dc584db1cb8d1b3e4206a54e1f1eebe497eb/web-standard-kit
 */

const THEME_STORAGE_KEY = "game-manage-kit-theme";
const TOAST_VARIANTS = new Set(["success", "info", "warning", "danger"]);
const TOAST_ICONS = Object.freeze({
  success: "#check",
  info: "#info",
  warning: "#warning",
  danger: "#warning",
});

function storedTheme(storage) {
  try {
    const value = storage?.getItem(THEME_STORAGE_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

export function initTheme({
  root = globalThis.document?.documentElement,
  button = globalThis.document?.querySelector("[data-theme-toggle]"),
  storage = globalThis.localStorage,
} = {}) {
  if (!root || !button) {
    return () => undefined;
  }

  function applyTheme(theme) {
    const nextTheme = theme === "dark" ? "dark" : "light";
    root.dataset.theme = nextTheme;
    const nextLabel = nextTheme === "dark" ? "浅色" : "深色";
    button.setAttribute("aria-label", `切换到${nextLabel}主题`);
    button.setAttribute("title", `切换到${nextLabel}主题`);
  }

  applyTheme(
    storedTheme(storage)
      ?? (root.dataset.theme === "dark" ? "dark" : "light"),
  );

  const toggle = () => {
    const nextTheme = root.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(nextTheme);
    try {
      storage?.setItem(THEME_STORAGE_KEY, nextTheme);
    } catch {
      // The current page can still use the selected theme.
    }
  };

  button.addEventListener("click", toggle);
  return () => button.removeEventListener("click", toggle);
}

export function initPasswordControls({
  document = globalThis.document,
} = {}) {
  if (!document) {
    return () => undefined;
  }

  const cleanups = [];
  for (const button of document.querySelectorAll("[data-password]")) {
    const inputId = button.getAttribute("aria-controls");
    const input = inputId ? document.getElementById(inputId) : null;
    if (!input || input.tagName !== "INPUT") {
      continue;
    }

    resetPasswordControl(input, button);
    const toggle = () => {
      const reveal = input.type === "password";
      setPasswordVisibility(input, button, reveal);
    };

    button.addEventListener("click", toggle);
    cleanups.push(() => button.removeEventListener("click", toggle));
  }

  return () => {
    for (const cleanup of cleanups) {
      cleanup();
    }
  };
}

function setPasswordVisibility(input, button, reveal) {
  input.type = reveal ? "text" : "password";
  button.setAttribute("aria-pressed", String(reveal));
  button.setAttribute("aria-label", reveal ? "隐藏密码" : "显示密码");
  button.setAttribute("title", reveal ? "隐藏密码" : "显示密码");
  button
    .querySelector("use")
    ?.setAttribute("href", reveal ? "#eye-off" : "#eye");
}

export function resetPasswordControl(input, button) {
  if (!input || !button) {
    return;
  }
  setPasswordVisibility(input, button, false);
}

function toastIcon(document, href) {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.classList.add("wsk-icon");
  icon.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", href);
  icon.append(use);
  return icon;
}

export function createToastController({
  document = globalThis.document,
  region = document?.getElementById("toast-region"),
  durationMs = 4200,
  schedule = globalThis.setTimeout?.bind(globalThis),
} = {}) {
  if (!document || !region || !schedule) {
    return () => undefined;
  }

  return (message, requestedVariant = "success") => {
    const variant = TOAST_VARIANTS.has(requestedVariant)
      ? requestedVariant
      : "success";
    const toast = document.createElement("div");
    toast.className = "wsk-toast";
    if (variant !== "success") {
      toast.classList.add(`wsk-${variant}`);
    }
    toast.setAttribute("role", variant === "danger" ? "alert" : "status");

    const text = document.createElement("span");
    text.textContent = String(message);
    toast.append(toastIcon(document, TOAST_ICONS[variant]), text);
    region.append(toast);
    schedule(() => toast.remove(), durationMs);
  };
}

export const wskThemeStorageKey = THEME_STORAGE_KEY;
