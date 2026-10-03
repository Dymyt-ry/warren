// Interface language. The English text is the key: t("Sign in") returns the
// Czech line when the person picked Czech and a translation exists, else the
// English. Placeholders: t("Join {name}", { name }). Translations: cs.ts.
import { useSyncExternalStore } from "react";
import { CS } from "./cs";

export type Language = "en" | "cs";
export const LANGUAGES: { id: Language; label: string }[] = [
  { id: "en", label: "English" },
  { id: "cs", label: "Čeština" },
];

const KEY = "warren.language";
const listeners = new Set<() => void>();

function initial(): Language {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "en" || saved === "cs") return saved;
  } catch {}
  return navigator.language?.toLowerCase().startsWith("cs") ? "cs" : "en";
}

let current: Language = initial();
document.documentElement.lang = current;

export function setLanguage(lang: Language) {
  if (lang === current) return;
  current = lang;
  document.documentElement.lang = lang;
  try {
    localStorage.setItem(KEY, lang);
  } catch {}
  for (const l of listeners) l();
}

export const language = () => current;

/** Re-renders the caller when the language changes. */
export function useLanguage(): Language {
  return useSyncExternalStore(
    (cb) => (listeners.add(cb), () => listeners.delete(cb)),
    () => current,
  );
}

export function t(text: string, vars?: Record<string, string | number>): string {
  const out = (current === "cs" && CS[text]) || text;
  return vars ? out.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : out;
}

/** "1 room", "2 rooms": English and Czech plural forms. */
export function plural(n: number, en: [string, string], cs: [string, string, string]): string {
  if (current === "cs") return `${n} ${n === 1 ? cs[0] : n >= 2 && n <= 4 ? cs[1] : cs[2]}`;
  return `${n} ${n === 1 ? en[0] : en[1]}`;
}

export const formatDate = (iso: string, opts: Intl.DateTimeFormatOptions) => new Date(iso).toLocaleString(current === "cs" ? "cs-CZ" : "en-GB", opts);

// --- theme -----------------------------------------------------------------------

export type Theme = "system" | "light" | "dark";
const THEME_KEY = "warren.theme";

/** Applies a theme to the page; "system" follows the operating system. */
export function applyTheme(theme: Theme) {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {}
}

export function savedTheme(): Theme {
  try {
    const t = localStorage.getItem(THEME_KEY);
    if (t === "light" || t === "dark" || t === "system") return t;
  } catch {}
  return "system";
}
