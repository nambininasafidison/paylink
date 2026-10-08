// SPDX-License-Identifier: MIT
/**
 * Per-device interface preferences in localStorage: language, theme, the remembered wallet (its EIP-6963 rdns only)
 * and the till chime. Never anything that must persist reliably, and never keys or amounts. Storage can be refused
 * (private windows, blocked site data): every access is wrapped and the app works without it.
 */
import { isLocale } from "@paylink/i18n";
import type { Locale } from "@paylink/i18n";

export type Theme = "auto" | "light" | "dark";

interface Pref<T> {
  get(): T;
  set(value: T): void;
}

function pref<T>(name: string, fallback: T, parse: (raw: string) => T | null, serialise: (value: T) => string | null): Pref<T> {
  const key = `paylink.${name}`;
  return {
    get() {
      try {
        const raw = localStorage.getItem(key);
        return raw === null ? fallback : (parse(raw) ?? fallback);
      } catch {
        return fallback;
      }
    },
    set(value) {
      try {
        const raw = serialise(value);
        if (raw === null) {
          localStorage.removeItem(key);
        } else {
          localStorage.setItem(key, raw);
        }
      } catch {
        // Storage refused: the preference lasts for this page only.
      }
    },
  };
}

export const prefs = {
  locale: pref<Locale | null>("locale", null, (raw) => (isLocale(raw) ? raw : null), (v) => v),
  theme: pref<Theme>("theme", "auto", (raw) => (raw === "light" || raw === "dark" || raw === "auto" ? raw : null), (v) => (v === "auto" ? null : v)),
  wallet: pref<string | null>("wallet", null, (raw) => (/^[a-z0-9.-]{1,128}$/i.test(raw) ? raw : null), (v) => v),
  chime: pref<boolean>("chime", true, (raw) => raw === "on" || (raw === "off" ? false : null), (v) => (v ? "on" : "off")),
};

/** Applies a theme choice to the document (`data-theme` is what the v1 tokens key on). */
export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  if (theme === "auto") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", theme);
  }
}
