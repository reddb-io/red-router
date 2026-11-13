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

test("provider definitions bind accounts and preserve approved shared updates after reload", async ({
  page,
}) => {
  await page.goto("/dashboard");
  await page.getByLabel("Administrator key").fill(ADMIN_KEY);
  await page.getByRole("button", { name: "Sign in locally" }).click();
  await expect(page.getByRole("heading", { name: "Operations overview" })).toBeVisible();
  await page.getByRole("button", { name: "Routing", exact: true }).click();
  await page.getByRole("link", { name: "Providers", exact: true }).click();
  await page.getByRole("button", { name: "Add provider definition", exact: true }).click();
  await page.getByLabel("Definition ID", { exact: true }).fill("gateway-definition-e2e");
  await page.getByLabel("Definition name", { exact: true }).fill("E2E gateway");
  await page.getByLabel("Provider prefix", { exact: true }).fill("gateway-e2e");
  await page.getByLabel("Base URL", { exact: true }).fill("http://127.0.0.1:1/v1");
  await page.getByLabel("Inference path", { exact: true }).fill("/infer");
  await page.getByLabel("Model discovery path", { exact: true }).fill("/catalog");
  await page.getByRole("button", { name: "Save provider definition", exact: true }).click();
  await expect(page.getByRole("button", { name: "Edit definition", exact: true })).toBeVisible();
  await page.getByLabel(/^Provider definition/).selectOption("gateway-definition-e2e");
  await page.getByLabel("Connection ID", { exact: true }).fill("gateway-account-e2e");
  await page
    .getByLabel("API key or provider credential", { exact: false })
    .fill("e2e-provider-fixture-secret");
  await page.getByRole("button", { name: "Add connection", exact: true }).click();
  await expect(page.getByRole("button", { name: "Replace", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove definition", exact: true })).toBeDisabled();
  await page.reload();
  await page.getByRole("button", { name: "Replace", exact: true }).click();
  await expect(page.getByLabel(/^Provider definition/)).toHaveValue("gateway-definition-e2e");
  await expect(page.getByLabel("Upstream URL", { exact: true })).toHaveValue(
    "http://127.0.0.1:1/v1/infer"
  );
  await expect(page.getByLabel("Upstream URL", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Edit definition", exact: true }).click();
  const sharedHeaders = page.getByLabel("Shared replacement headers (JSON)", { exact: true });
  await expect(sharedHeaders).toBeEnabled();
  await sharedHeaders.fill('{"X-Project":"e2e-shared-secret"}');
  await page.getByRole("button", { name: "Replace shared headers", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Custom headers saved and activated.");
  await expect(sharedHeaders).toHaveValue("");
  await page.reload();
  await page.getByRole("button", { name: "Edit definition", exact: true }).click();
  await expect(page.getByText("Configured: x-project", { exact: true })).toBeVisible();
  await expect(sharedHeaders).toHaveValue("");
  await expect(page.locator("body")).not.toContainText("e2e-shared-secret");
  await page.getByLabel("Inference path", { exact: true }).fill("/next");
  await page.getByRole("button", { name: "Save provider definition", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Confirm applying endpoint changes to linked accounts"
  );
  await page.getByLabel(/Apply endpoint, protocol or prefix changes/).check();
  await page.getByRole("button", { name: "Save provider definition", exact: true }).click();
  await expect(page.getByLabel("Definition ID", { exact: true })).toHaveCount(0);
  await page.reload();
  await page.getByRole("button", { name: "Replace", exact: true }).click();
  await expect(page.getByLabel("Upstream URL", { exact: true })).toHaveValue(
    "http://127.0.0.1:1/v1/next"
  );
  await expect(page.getByLabel("API key or provider credential", { exact: false })).toHaveValue("");
  await page.getByRole("button", { name: "Edit definition", exact: true }).click();
  await expect(page.getByText("The destination changed.", { exact: false })).toBeVisible();
  await expect(sharedHeaders).toHaveValue("");
  await page.getByRole("button", { name: "Remove shared headers", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Custom headers removed.");
  await page.reload();
  await page.getByRole("button", { name: "Edit definition", exact: true }).click();
  await expect(page.getByText("Configured: None", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Remove shared headers", exact: true })
  ).toBeDisabled();
});

test("the SPA creates a local API connection without a provider credential", async ({ page }) => {
  await page.goto("/dashboard");
  await page.getByLabel("Administrator key").fill(ADMIN_KEY);
  await page.getByRole("button", { name: "Sign in locally" }).click();
  await expect(page.getByRole("heading", { name: "Operations overview" })).toBeVisible();
  await page.getByRole("button", { name: "Routing", exact: true }).click();
  await page.getByRole("link", { name: "Providers", exact: true }).click();
  await page.getByLabel("Connection ID", { exact: true }).fill("local-no-auth-e2e");
  await page
    .getByLabel("Upstream URL", { exact: true })
    .fill("http://127.0.0.1:1/v1/chat/completions");
  await page.getByLabel(/^Credential authentication/).selectOption("none");
  await expect(page.getByLabel("API key or provider credential", { exact: false })).toBeDisabled();
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/admin/providers/local-no-auth-e2e") &&
      response.request().method() === "PUT"
  );
  await page.getByRole("button", { name: "Add connection", exact: true }).click();
  const response = await saved;
  expect(response.ok()).toBe(true);
  expect(await response.json()).toMatchObject({
    provider: { auth_scheme: "none", has_credential: false },
  });
  await page.reload();
  await expect(page.getByText("local-no-auth-e2e", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Not required", { exact: true })).toBeVisible();
});

test("custom model metadata is created, edited and removed through the production SPA", async ({
  page,
}) => {
  await page.goto("/dashboard");
  await page.getByLabel("Administrator key").fill(ADMIN_KEY);
  await page.getByRole("button", { name: "Sign in locally" }).click();
  await expect(page.getByRole("heading", { name: "Operations overview" })).toBeVisible();
  await page.getByRole("button", { name: "Routing", exact: true }).click();
  await page.getByRole("link", { name: "Models", exact: true }).click();
  await page.getByRole("button", { name: "Add custom model", exact: true }).click();
  await page.getByLabel("Model provider", { exact: true }).fill("private-api");
  await page.getByLabel("Custom model ID", { exact: true }).fill("browser-custom-model");
  await page.getByLabel("Model display name", { exact: true }).fill("Browser custom model");
  await page.getByLabel("Context window", { exact: true }).fill("4096");
  await page.getByLabel(/^Input price/).fill("1.5");
  await page.getByLabel(/^Output price/).fill("2.5");
  await page.getByLabel(/^Hide from client model lists/).check();
  await page.getByRole("button", { name: "Save custom model", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Custom model saved.");
  await page.reload();
  await expect(page.getByText("Browser custom model", { exact: true })).toBeVisible();
  await expect(page.getByText("Hidden", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit model", exact: true }).click();
  await expect(page.getByLabel(/^Hide from client model lists/)).toBeChecked();
  await page.getByLabel(/^Hide from client model lists/).uncheck();
  await expect(page.getByLabel(/^Input price/)).toHaveValue("1.5");
  await expect(page.getByLabel("Context window", { exact: true })).toHaveValue("4096");
  await page.getByLabel(/^Input price/).fill("0");
  await page.getByRole("button", { name: "Save custom model", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Custom model saved.");
  await page.reload();
  await expect(page.getByText("0 / 2.5 USD / 1M", { exact: true })).toBeVisible();
  await expect(page.getByText("Hidden", { exact: true })).toHaveCount(0);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Remove model", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Custom model removed.");
  await page.reload();
  await expect(page.getByText("Browser custom model", { exact: true })).toHaveCount(0);
});

test("model aliases persist target changes and removal through the SPA", async ({ page }) => {
  await page.goto("/dashboard");
  await page.getByLabel("Administrator key").fill(ADMIN_KEY);
  await page.getByRole("button", { name: "Sign in locally" }).click();
  await expect(page.getByRole("heading", { name: "Operations overview" })).toBeVisible();
  await page.getByRole("button", { name: "Routing", exact: true }).click();
  await page.getByRole("link", { name: "Models", exact: true }).click();
  await page.getByRole("button", { name: "Add model alias", exact: true }).click();
  await page.getByLabel("Client model name", { exact: true }).fill("browser-friendly");
  await page.getByLabel("Alias provider", { exact: true }).fill("private-api");
  await page.getByLabel("Upstream model ID", { exact: true }).fill("upstream-one");
  await page.getByRole("button", { name: "Save model alias", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Model alias saved.");
  await page.reload();
  await expect(page.getByText("browser-friendly", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit alias", exact: true }).click();
  await expect(page.getByLabel("Upstream model ID", { exact: true })).toHaveValue("upstream-one");
  await page.getByLabel("Upstream model ID", { exact: true }).fill("upstream-two");
  await page.getByRole("button", { name: "Save model alias", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Model alias saved.");
  await page.reload();
  await expect(page.getByText("upstream-two", { exact: true })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Remove alias", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Model alias removed.");
  await page.reload();
  await expect(page.getByText("browser-friendly", { exact: true })).toHaveCount(0);
});
