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
    for (const label of [
      "Setup",
      "Models",
      "Tenants",
      "Users",
      "Roles",
      "Network",
      "Settings › Prompts",
    ]) {
      await expect(page.getByRole("switch", { name: `Show: ${label}`, exact: true })).toBeChecked();
    }
    await page.goto("/home/setup");
    await expect(page.getByLabel("Client model", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Run validation", exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true);
    if (width === 1280) {
      // Verify the actual rail/panel consumers as well as the settings tree.
      await page.getByRole("button", { name: "Access", exact: true }).click();
      for (const href of ["/access/tenants", "/access/users", "/access/roles"]) {
        await expect(page.locator(`a[href="${href}"]`).first()).toBeVisible();
      }
      await page.getByRole("button", { name: "Proxy", exact: true }).click();
      await expect(page.locator('a[href="/proxy/models"]').first()).toBeVisible();
      await page.getByRole("button", { name: "System", exact: true }).click();
      await expect(page.locator('a[href="/system/network"]').first()).toBeVisible();
      await page.locator('a[href="/system/network"]').first().click();
      await expect(
        page.getByRole("heading", { name: "Network access", exact: true })
      ).toBeVisible();
      await page.goto("/system/settings/prompts");
      await expect(page.getByLabel("Before client instructions")).toBeVisible();
      await page.getByRole("button", { name: "Home", exact: true }).click();
      await expect(page.locator('a[href="/home/setup"]').first()).toBeVisible();
    }
    if (width === 390)
      await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    await page.getByRole("button", { name: "Search", exact: true }).first().click();
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await expect(palette).toBeVisible();
    await palette.getByRole("textbox").fill("Caveman");
    await expect(palette.getByRole("option")).toContainText("Token saver › Caveman");
    await palette.getByRole("option").getByRole("button").click();
    await expect(page).toHaveURL(/\/optimize\/token-saver\/engines\/caveman/);
    expect(errors).toEqual([]);
  });
}
