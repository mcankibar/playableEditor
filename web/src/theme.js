const KEY = "pl-theme";

export function preferredTheme() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "dark" || saved === "light") return saved;
  } catch {}
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {}
  return theme;
}

export function toggleTheme() {
  return applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
}
