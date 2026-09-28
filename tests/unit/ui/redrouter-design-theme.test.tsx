// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import useThemeStore from "@/store/themeStore";

beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
  document.documentElement.dataset.theme = "application";
  document.documentElement.dataset.density = "comfortable";
  useThemeStore.setState({ theme: "light", colorTheme: "coral", customColor: "#123456" });
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("style");
  document.documentElement.classList.remove("dark");
  delete document.documentElement.dataset.colorScheme;
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.density;
  localStorage.clear();
});

describe("RedRouter DS appearance adapter", () => {
  it.each(["light", "dark", "system"])(
    "synchronizes %s without changing Theme or Density",
    (theme) => {
      useThemeStore.getState().setTheme(theme);
      const expected = theme === "light" ? "light" : "dark";
      expect(document.documentElement.dataset.colorScheme).toBe(expected);
      expect(document.documentElement.classList.contains("dark")).toBe(expected === "dark");
      expect(document.documentElement.dataset.theme).toBe("application");
      expect(document.documentElement.dataset.density).toBe("comfortable");
    }
  );

  it("restores the DS default after a custom color without hard-coding another palette", () => {
    useThemeStore.getState().setCustomColorTheme("#123456");
    expect(document.documentElement.style.getPropertyValue("--color-primary")).toBe("#123456");
    useThemeStore.getState().setColorTheme("coral");
    expect(document.documentElement.style.getPropertyValue("--color-primary")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--color-primary-hover")).toBe("");
  });

  it("preserves explicit named colors and persists the appearance preference", () => {
    useThemeStore.getState().setColorTheme("blue");
    useThemeStore.getState().setTheme("dark");
    expect(document.documentElement.style.getPropertyValue("--color-primary")).toBe("#3b82f6");
    expect(JSON.parse(localStorage.getItem("theme")!).state.theme).toBe("dark");
  });
});
