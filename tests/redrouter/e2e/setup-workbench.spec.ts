import { expect, test } from "@playwright/test";

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`Setup keeps connection/model selection and honest progress at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    const password =
      process.env.OMNIROUTE_E2E_PASSWORD ||
      process.env.INITIAL_PASSWORD ||
      "omniroute-e2e-password";
    const login = await page.request.post("/api/auth/login", { data: { password } });
    expect(login.ok()).toBe(true);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.route("**/api/providers", (route) =>
      route.fulfill({
        json: {
          connections: [{ id: "connection", provider: "openrouter", name: "Work", isActive: true }],
        },
      })
    );
    let issued = false;
    await page.route("**/api/keys", (route) => {
      if (route.request().method() === "POST") {
        issued = true;
        return route.fulfill({ json: { id: "client-key", key: "client-secret", name: "Client" } });
      }
      return route.fulfill({
        json: {
          keys: issued ? [{ id: "client-key", name: "Client", key: "masked", isActive: true }] : [],
        },
      });
    });
    await page.route("**/api/providers/connection/models?*", (route) =>
      route.fulfill({
        json: {
          models: [
            {
              fullModel: "openrouter/reasoner",
              capabilities: { reasoning: true, tool_calling: true },
            },
          ],
        },
      })
    );
    await page.route("**/api/combos/recommended", (route) =>
      route.fulfill({ json: { recommendations: [] } })
    );
    await page.route("**/api/setup/validate", (route) => {
      expect(route.request().postDataJSON()).toEqual({
        connectionId: "connection",
        model: "openrouter/reasoner",
        apiKeyId: "client-key",
        apiKey: "client-secret",
      });
      return route.fulfill({ json: { status: "ready", inferenceTested: false, checks: [] } });
    });
    await page.goto("/dashboard/setup");
    await expect(page.getByRole("heading", { name: "Get RedRouter ready" })).toBeVisible();
    await page
      .getByRole("combobox", { name: "Client model", exact: true })
      .selectOption("openrouter/reasoner");
    await page.getByRole("button", { name: "Create key", exact: true }).click();
    await page.getByRole("button", { name: "Copy config", exact: true }).click();
    await expect(page.getByRole("button", { name: "Copy config", exact: true })).toBeVisible();
    await expect(
      page.locator("ol > li").nth(2).getByRole("img", { name: "Complete", exact: true })
    ).toBeVisible();
    await page.getByRole("button", { name: "Run validation", exact: true }).click();
    await expect(page.getByText("Configuration checked.", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("redrouter:setup:v1"))).not.toContain(
      "client-secret"
    );
    await page.reload();
    await expect(page.getByRole("combobox", { name: "Client model", exact: true })).toHaveValue(
      "openrouter/reasoner"
    );
    await expect(page.getByRole("button", { name: "Copy config", exact: true })).toBeDisabled();
    await expect(page.getByText("Configuration checked.", { exact: true })).toHaveCount(0);
    expect(
      errors.filter((message) => /hydration|Minified React error #418|did not match/i.test(message))
    ).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true);
  });
}
