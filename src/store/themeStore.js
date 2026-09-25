"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { THEME_CONFIG } from "@/shared/constants/config";

const useThemeStore = create(
  persist(
    (set, get) => ({
      theme: THEME_CONFIG.defaultTheme,

      setTheme: (theme) => {
        set({ theme });
        applyTheme(theme);
      },

      toggleTheme: () => {
        const currentTheme = get().theme;
        const newTheme = currentTheme === "dark" ? "light" : "dark";
        set({ theme: newTheme });
        applyTheme(newTheme);
      },

      initTheme: () => {
        const theme = get().theme;
        applyTheme(theme);
      },
    }),
    {
      name: THEME_CONFIG.storageKey,
    }
  )
);

// Apply theme to document
export function applyTheme(theme) {
  if (typeof window === "undefined") return;

  const root = document.documentElement;
  const systemTheme = window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";

  const effectiveTheme = theme === "system" ? systemTheme : theme;

  // The vendored RedDB Design System styles key off data attributes:
  // theme-application.css applies under [data-theme="application"] and the
  // scheme files under [data-color-scheme]. The .dark class stays for the
  // Tailwind @custom-variant; both stay in sync from the same place.
  root.setAttribute("data-theme", "application");
  if (effectiveTheme === "dark") {
    root.classList.add("dark");
    root.setAttribute("data-color-scheme", "dark");
  } else {
    root.classList.remove("dark");
    root.setAttribute("data-color-scheme", "light");
  }
}

export default useThemeStore;

