"use client";

import { useEffect } from "react";
import useThemeStore, { applyTheme } from "@/store/themeStore";
import { THEME_CONFIG } from "@/shared/constants/config";
import { useBranding } from "./BrandingProvider";

export function ThemeProvider({ children }) {
  const { initTheme } = useThemeStore();
  const { colorScheme } = useBranding();

  useEffect(() => {
    // Until the user picks a theme, a white-label brand's colour scheme is the
    // default. It is applied, not stored, so a later branding change still applies.
    let chosen = null;
    try { chosen = localStorage.getItem(THEME_CONFIG.storageKey); } catch { /* private mode */ }
    if (!chosen && colorScheme) applyTheme(colorScheme);
    else initTheme();
  }, [initTheme, colorScheme]);

  return <>{children}</>;
}

