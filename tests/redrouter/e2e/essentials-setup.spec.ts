import { expect, test } from "@playwright/test";
import { HIDEABLE_SIDEBAR_ITEM_IDS } from "../../../src/shared/constants/sidebarVisibility";

for (const width of [1280, 390]) {
  test(`legacy Essentials exposes Setup, Models and tenant administration at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const password =
      process.env.OMNIROUTE_E2E_PASSWORD ||
      process.env.INITIAL_PASSWORD ||
      "omniroute-e2e-password";
    expect((await page.request.post("/api/auth/login", { data: { password } })).ok()).toBe(true);
    const settingsRes = await page.request.get("/api/settings");
    expect(settingsRes.ok()).toBe(true);
    const settings = await settingsRes.json();
    const shown = new Set([
      "home",
      "endpoints",
      "api-manager",
      "providers",
      "health",
      "settings-general",
      "settings-sidebar",
    ]);
    await page.route("**/api/settings", (route) =>
      route.fulfill({
        json: {
          ...settings,
          sidebarActivePreset: "essentials",
          hiddenSidebarItems: HIDEABLE_SIDEBAR_ITEM_IDS.filter((id) => !shown.has(id)),
        },
      })
    );
    await page.goto("/system/settings/sidebar");
    for (const label of ["Setup", "Models", "Tenants", "Users", "Roles"]) {
      await expect(page.getByRole("switch", { name: `Show: ${label}`, exact: true })).toBeChecked();
    }
    await page.goto("/home/setup");
    await expect(page.getByLabel("Client model", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Run validation", exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true);
    expect(errors).toEqual([]);
  });
}
