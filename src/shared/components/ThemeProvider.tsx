"use client";

import { useEffect } from "react";
import useThemeStore from "@/store/themeStore";
import { useBranding } from "./BrandingProvider";

export function ThemeProvider({ children }) {
  const { initTheme } = useThemeStore();
  const { theme } = useBranding();

  useEffect(() => {
    initTheme();
    // A branding.json theme is the white-label source of truth: it overrides
    // the persisted color-theme choice for the accent colors.
    if (theme.primary) {
      const root = document.documentElement;
      root.style.setProperty("--color-primary", theme.primary);
      root.style.setProperty(
        "--color-primary-hover",
        theme.primaryHover || `color-mix(in srgb, ${theme.primary} 86%, black)`
      );
    }
  }, [initTheme, theme]);

  return <>{children}</>;
}
