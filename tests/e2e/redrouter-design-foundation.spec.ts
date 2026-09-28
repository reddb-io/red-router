import { expect, test } from "@playwright/test";

for (const scheme of ["light", "dark"] as const) {
  test(`RedRouter DS foundation renders in ${scheme} with local fonts`, async ({ page }) => {
    await page.addInitScript((theme) => {
      localStorage.setItem(
        "theme",
        JSON.stringify({ state: { theme, colorTheme: "coral" }, version: 0 })
      );
    }, scheme);
    await page.goto("/login");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "application");
    await expect(page.locator("html")).toHaveAttribute("data-color-scheme", scheme);
    const computed = await page.evaluate(async () => {
      const body = getComputedStyle(document.body);
      const probe = document.createElement("span");
      probe.style.backgroundColor = "var(--reddb-color-background)";
      document.body.append(probe);
      const background = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const fonts = await document.fonts.load('16px "Space Grotesk"');
      return {
        actualBackground: body.backgroundColor,
        background,
        font: body.fontFamily,
        loaded: fonts.length > 0 && fonts.every((font) => font.status === "loaded"),
      };
    });
    expect(computed.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(computed.actualBackground).toBe(computed.background);
    expect(computed.font).toContain("Space Grotesk");
    expect(computed.loaded).toBe(true);
  });
}
