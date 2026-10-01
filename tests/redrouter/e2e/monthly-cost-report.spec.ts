import { expect, test } from "@playwright/test";

for (const width of [1280, 390]) {
  test(`monthly usage is readable and consistent in Keys, Costs and Tenants at ${width}px`, async ({
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
    const direct = await page.request.get("/api/usage/monthly-report?month=2026-09");
    expect(direct.ok()).toBe(true);
    expect((await direct.json()).report.sources).toEqual({
      requests: "usage_history",
      cost: "request_cost_ledger",
    });
    const totals = {
      requests: 7,
      errors: 1,
      inputTokens: 100,
      outputTokens: 20,
      ledgerEntries: 2,
      recordedCostUsd: 0.25,
    };
    await page.route("**/api/usage/monthly-report?*", (route) => {
      const month = new URL(route.request().url()).searchParams.get("month")!;
      return route.fulfill({
        json: {
          report: {
            month,
            timezone: "UTC",
            since: `${month}-01T00:00:00.000Z`,
            until: "2026-10-01T00:00:00.000Z",
            total: totals,
            keys: [
              {
                ...totals,
                tenantId: "fixture",
                tenantName: "Fixture tenant",
                apiKeyId: "fixture-key",
                name: "Fixture key",
                current: true,
                lastUsed: "2026-09-15T12:00:00.000Z",
              },
            ],
            sources: { requests: "usage_history", cost: "request_cost_ledger" },
            coverage: "Entry counts are not pricing coverage. Recorded amounts are not invoices.",
          },
        },
      });
    });
    await page.route("**/api/tenants", (route) =>
      route.fulfill({
        json: {
          tenants: [
            {
              id: "fixture",
              slug: "fixture",
              name: "Fixture tenant",
              disabled: false,
              isDefault: false,
              admins: 0,
              users: 0,
              apiKeys: 1,
              connections: 0,
              combos: 0,
            },
          ],
        },
      })
    );
    await page.route("**/api/tenants/fixture/users", (route) =>
      route.fulfill({ json: { users: [] } })
    );
    await page.route("**/api/tenants/fixture/profile", (route) =>
      route.fulfill({
        json: {
          profile: {
            ownerUserId: null,
            ownerEmail: "",
            technicalEmail: "",
            billingEmail: "",
            description: "",
            metadata: {},
          },
        },
      })
    );
    for (const path of [
      "/proxy/keys",
      "/observe/costs?month=2026-09",
      "/access/tenants?tenant=fixture",
    ]) {
      await page.goto(path);
      const report = page.getByRole("region", { name: "Monthly recorded usage" });
      await expect(report).toBeVisible();
      await report.getByLabel("Usage month (UTC)").fill("2026-09");
      await expect(
        report.getByRole("cell", { name: "$0.2500", exact: true }).first()
      ).toBeVisible();
      await expect(
        report.getByText("Entry counts are not pricing coverage.", { exact: false })
      ).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      ).toBe(true);
    }
    expect(errors).toEqual([]);
  });
}
