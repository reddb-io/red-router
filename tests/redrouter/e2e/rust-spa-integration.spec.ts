import { expect, test } from "@playwright/test";

const ADMIN_KEY = process.env.RED_ROUTER_ADMIN_KEY || "red-router-e2e-admin-key-00000001";

test("red-routerd serves and authenticates the production SPA", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "RedRouter", exact: true })).toBeVisible();
  await page.getByLabel("Administrator key").fill(ADMIN_KEY);
  await page.getByRole("button", { name: "Sign in locally" }).click();

  await expect(page.getByRole("heading", { name: "Operations overview" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Product areas" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Dashboard navigation" })).toBeVisible();
  const config = await page.request.get("/api/auth/config");
  expect(config.ok()).toBe(true);
  expect(await config.json()).toMatchObject({
    backend: "rust",
    control_plane_enabled: true,
    password_login: true,
  });

  const pages = [
    ["Routing", "Endpoint", "Endpoint"],
    ["Routing", "Providers", "Provider connections"],
    ["Routing", "Resilience", "Provider resilience and quotas"],
    ["Routing", "Models", "Model catalog"],
    ["Routing", "Combos", "Routing combos"],
    ["Access", "API keys", "API keys"],
    ["Access", "Budgets", "Shared budgets"],
    ["Observe", "Usage destinations", "Usage destinations"],
    ["Observe", "Usage report", "Usage report"],
    ["Observe", "Usage history", "Historical usage"],
    ["Access", "Organizations", "Organizations and identities"],
    ["Observe", "Audit log", "Audit log"],
    ["System", "Single sign-on", "Single sign-on"],
  ] as const;
  for (const [area, link, heading] of pages) {
    await page.getByRole("button", { name: area, exact: true }).click();
    await page.getByRole("link", { name: link, exact: true }).click();
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
  }

  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByLabel("Administrator key")).toBeVisible();
});

test("the SPA persists organization and named client-key metadata through Rust", async ({
  page,
}) => {
  await page.goto("/dashboard");
  await page.getByLabel("Administrator key").fill(ADMIN_KEY);
  await page.getByRole("button", { name: "Sign in locally" }).click();
  await expect(page.getByRole("heading", { name: "Operations overview" })).toBeVisible();

  await page.getByRole("button", { name: "Access", exact: true }).click();
  await page.getByRole("link", { name: "Organizations", exact: true }).click();
  await page.getByLabel("Organization ID").fill("acme-e2e");
  await page.getByLabel("Slug", { exact: true }).fill("acme-e2e");
  await page.getByLabel("Name", { exact: true }).fill("Acme E2E");
  await page.getByRole("button", { name: "Save organization" }).click();
  await expect(page.getByRole("status")).toContainText("Organization Acme E2E saved.");
  await expect(page.getByRole("cell", { name: "Acme E2E", exact: true })).toBeVisible();

  await page.getByRole("link", { name: "API keys", exact: true }).click();
  await page.getByLabel("Label", { exact: true }).fill("RedDB database client");
  await page.getByRole("button", { name: "Issue key", exact: true }).click();
  await expect(page.getByText("RedDB database client", { exact: true })).toBeVisible();
  await expect(page.getByText("Copy this key now", { exact: false })).toBeVisible();

  await page.reload();
  await expect(page.getByText("RedDB database client", { exact: true })).toBeVisible();
});
