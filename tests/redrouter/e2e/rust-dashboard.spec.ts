import { expect, test } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { build } from "vite";

let directory: string;
let server: Server;
let origin: string;

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "redrouter-spa-e2e-"));
  await build({
    configFile: resolve("rust-dashboard/vite.config.mjs"),
    logLevel: "error",
    build: { outDir: directory, emptyOutDir: false },
  });
  server = createServer(async (request, response) => {
    const path = new URL(request.url || "/", "http://localhost").pathname;
    const asset = path.startsWith("/assets/");
    const file = asset ? join(directory, "assets", basename(path)) : join(directory, "index.html");
    try {
      const bytes = await readFile(file);
      response.setHeader("content-type", asset ? (path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "application/octet-stream") : "text/html");
      response.end(bytes);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Static server unavailable");
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  if (server) await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("static dashboard uses Rust session and API routes", async ({ page, context }) => {
  const calls: Array<{ path: string; csrf: string | undefined }> = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    calls.push({ path, csrf: route.request().headers()["x-red-router-csrf"] });
    const responses: Record<string, unknown> = {
      "/api/auth/config": { backend: "rust", control_plane_enabled: true, oidc_browser_login: true, password_login: false },
      "/api/admin/providers": { providers: [] },
      "/api/admin/combos": { combos: [] },
      "/api/admin/client-keys": { client_keys: [] },
      "/api/admin/provider-quotas": { provider_quotas: [] },
      "/api/admin/provider-health": { provider_health: [] },
      "/api/admin/usage": { usage: Object.fromEntries(["request_count", "priced_request_count", "tokens_input", "tokens_output", "tokens_cache_read", "tokens_cache_creation", "tokens_reasoning", "amount_microusd", "pending_request_count", "pending_reserved_tokens", "pending_reserved_microusd"].map((key) => [key, 0])) },
    };
    await route.fulfill({ status: responses[path] ? 200 : 503, json: responses[path] ?? { error: "unavailable" } });
  });
  await page.goto(origin);
  await expect(page.getByRole("button", { name: "Sign in with OpenID Connect" })).toBeVisible();
  await context.addCookies([{ name: "redrouter_admin_csrf", value: "fixture-csrf", url: origin }]);
  await page.goto(`${origin}/dashboard/providers`);
  await expect(page.getByRole("heading", { name: "Provider connections" })).toBeVisible();
  await expect(page.getByText("No provider connections configured in Rust.")).toBeVisible();
  await page.getByRole("link", { name: "Combos", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Routing combos" })).toBeVisible();
  await expect(page.getByText("No Rust combos configured yet.")).toBeVisible();
  await page.getByRole("link", { name: "API keys", exact: true }).click();
  await expect(page.getByRole("heading", { name: "API keys" })).toBeVisible();
  await expect(page.getByText("No Rust-owned client keys yet.")).toBeVisible();
  for (const path of ["/api/admin/providers", "/api/admin/combos", "/api/admin/client-keys"]) {
    expect(calls.some((call) => call.path === path && call.csrf === "fixture-csrf")).toBe(true);
  }

  await page.route("**/api/admin/client-keys", (route) => route.fulfill({ json: { client_keys: [{
    id: "key-one", label: "Database", tenant_id: "red", created_by: "admin", model_id_format: "prefixed",
    enabled: true, expires_at_unix: null, access_schedule: null, scopes: [], allowed_endpoints: [],
    allowed_models: [], blocked_models: [], allowed_provider_ids: [], max_concurrent_requests: null,
    max_requests_per_minute: null, max_requests_per_day: null, max_tokens_per_minute: null,
    max_tokens_per_day: null, max_spend_per_month_usd: null, reservation_tokens: null,
    reservation_spend_usd: null, revision: "1",
  }] } }));
  let created: Record<string, unknown> | null = null;
  await page.route("**/api/usage-sinks**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/types")) {
      await route.fulfill({ json: { types: [{ type: "webhook", label: "Webhook", description: "Signed usage", modes: ["instant"], fields: [
        { key: "url", labelFallback: "Webhook URL", type: "text", required: true },
        { key: "secret", labelFallback: "Signing secret", type: "password", required: true, secret: true },
      ] }] } });
    } else if (request.method() === "POST") {
      created = request.postDataJSON();
      expect(request.headers()["x-red-router-csrf"]).toBe("fixture-csrf");
      await route.fulfill({ status: 201, json: { sink: {} } });
    } else {
      await route.fulfill({ json: { sinks: [] } });
    }
  });
  await page.getByRole("link", { name: "Usage destinations", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Usage destinations" })).toBeVisible();
  await page.getByRole("button", { name: "Add destination" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Billing");
  await page.getByLabel("Webhook URL").fill("https://billing.example.com/usage");
  await page.getByLabel("Signing secret").fill("fixture-secret-123456789");
  await page.getByLabel("Limit to selected keys").check();
  await page.getByLabel("Database (key-one)").check();
  await page.getByRole("button", { name: "Save destination" }).click();
  await expect(page.getByRole("status")).toHaveText("Usage destination saved.");
  expect(created).toMatchObject({ name: "Billing", type: "webhook", mode: "instant", apiKeyIds: ["key-one"], config: { url: "https://billing.example.com/usage", secret: "fixture-secret-123456789" } });
});
