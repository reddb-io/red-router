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
      response.setHeader(
        "content-type",
        asset
          ? path.endsWith(".js")
            ? "text/javascript"
            : path.endsWith(".css")
              ? "text/css"
              : "application/octet-stream"
          : "text/html"
      );
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
  if (server)
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done()))
    );
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("playground sends a multi-turn conversation using the supplied client key", async ({ page, context }) => {
  await context.addCookies([{ name: "redrouter_admin_csrf", value: "fixture-csrf", url: origin }]);
  await page.route("**/api/auth/config", (route) => route.fulfill({ json: {
    backend: "rust", control_plane_enabled: true, oidc_browser_login: false, password_login: true,
  } }));
  const requests: unknown[] = [];
  await page.route("**/v1/chat/completions", async (route) => {
    expect(route.request().headers().authorization).toBe("Bearer local-client-key");
    requests.push(route.request().postDataJSON());
    await route.fulfill({ json: { choices: [{ message: { content: `Reply ${requests.length}` } }] } });
  });
  await page.goto(`${origin}/dashboard/playground`);
  await page.getByLabel("API key", { exact: true }).fill("local-client-key");
  await page.getByLabel("Model or combo").fill("openrouter/example");
  await page.getByLabel("Message", { exact: true }).fill("Hello");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Reply 1", { exact: true })).toBeVisible();
  await page.getByLabel("Message", { exact: true }).fill("Again");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Reply 2", { exact: true })).toBeVisible();
  expect(requests[1]).toMatchObject({ model: "openrouter/example", stream: false, messages: [
    { role: "user", content: "Hello" }, { role: "assistant", content: "Reply 1" }, { role: "user", content: "Again" },
  ] });
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain("local-client-key");
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(page.getByText("Reply 1", { exact: true })).not.toBeVisible();
});

test("static dashboard uses Rust session and API routes", async ({ page, context }) => {
  const calls: Array<{ path: string; csrf: string | undefined }> = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    calls.push({ path, csrf: route.request().headers()["x-red-router-csrf"] });
    if (path === "/api/admin/audit-log") {
      await route.fulfill({
        headers: { "x-total-count": "1" },
        json: [
          {
            id: "audit-one",
            timestamp: "2026-11-11T20:00:00Z",
            createdAt: "2026-11-11T20:00:00Z",
            action: "tenant.update",
            actor: "oidc:owner",
            tenantId: "red",
            target: "red",
            resourceType: "tenant",
            status: "success",
            requestId: "request-one",
            details: { enabled: true },
            metadata: { enabled: true },
            ip: null,
            ipAddress: null,
          },
        ],
      });
      return;
    }
    const responses: Record<string, unknown> = {
      "/api/auth/config": {
        backend: "rust",
        control_plane_enabled: true,
        oidc_browser_login: true,
        password_login: false,
      },
      "/api/admin/providers": { providers: [] },
      "/api/admin/combos": { combos: [] },
      "/api/admin/client-keys": { client_keys: [] },
      "/api/admin/budgets": { budgets: [] },
      "/api/admin/tenants": {
        tenants: [{ id: "red", slug: "red", name: "Red", enabled: true, revision: "1" }],
      },
      "/api/admin/identity-bindings": {
        identity_bindings: [
          {
            id: "owner",
            subject: "oidc:v1:owner",
            tenant_id: "red",
            role: "admin",
            enabled: true,
            revision: "1",
          },
        ],
      },
      "/api/admin/provider-quotas": { provider_quotas: [] },
      "/api/admin/provider-health": { provider_health: [] },
      "/api/admin/runtime-settings": {
        runtime_settings: {
          quota_preflight_enabled: true,
          quota_preflight_threshold_percent: 10,
          oauth_connection_cooldown: {
            base_cooldown_ms: 1_000,
            use_upstream_retry_hints: true,
            max_backoff_steps: 4,
          },
          apikey_connection_cooldown: {
            base_cooldown_ms: 1_000,
            use_upstream_retry_hints: true,
            max_backoff_steps: 4,
          },
          oauth_provider_breaker: {
            failure_threshold: 5,
            degradation_threshold: 2,
            reset_timeout_ms: 30_000,
          },
          apikey_provider_breaker: {
            failure_threshold: 5,
            degradation_threshold: 2,
            reset_timeout_ms: 30_000,
          },
          revision: "1",
        },
      },
      "/api/admin/usage": {
        usage: {
          ...Object.fromEntries(
            [
              "request_count",
              "priced_request_count",
              "tokens_input",
              "tokens_output",
              "tokens_cache_read",
              "tokens_cache_creation",
              "tokens_reasoning",
              "amount_microusd",
              "pending_request_count",
              "pending_reserved_tokens",
              "pending_reserved_microusd",
              "search_units",
            ].map((key) => [key, 0])
          ),
          entries: [],
          next_cursor: null,
        },
      },
    };
    await route.fulfill({
      status: responses[path] ? 200 : 503,
      json: responses[path] ?? { error: "unavailable" },
    });
  });
  await page.goto(origin);
  await expect(page.getByRole("button", { name: "Sign in with OpenID Connect" })).toBeVisible();
  await context.addCookies([{ name: "redrouter_admin_csrf", value: "fixture-csrf", url: origin }]);
  await page.goto(`${origin}/dashboard/providers`);
  await expect(page.getByRole("heading", { name: "Provider connections" })).toBeVisible();
  await expect(page.getByText("No provider connections configured.")).toBeVisible();
  await page.getByRole("link", { name: "Resilience", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Provider resilience and quotas" })).toBeVisible();
  await page.getByRole("link", { name: "Combos", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Routing combos" })).toBeVisible();
  await expect(page.getByText("No combos configured yet.")).toBeVisible();
  await page.getByRole("button", { name: "Access", exact: true }).click();
  await page.getByRole("link", { name: "API keys", exact: true }).click();
  await expect(page.getByRole("heading", { name: "API keys" })).toBeVisible();
  await expect(page.getByText("No client keys yet.")).toBeVisible();
  await page.getByRole("link", { name: "Budgets", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Shared budgets" })).toBeVisible();
  await expect(page.getByText("No shared budgets configured.")).toBeVisible();
  await page.getByRole("button", { name: "Observe", exact: true }).click();
  await page.getByRole("link", { name: "Usage report", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Usage report" })).toBeVisible();
  await expect(page.getByText("No usage in this period.")).toBeVisible();
  await page.getByRole("button", { name: "Access", exact: true }).click();
  await page.getByRole("link", { name: "Organizations", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Organizations and identities" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Red", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "owner", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Observe", exact: true }).click();
  await page.getByRole("link", { name: "Audit log", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Audit log" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "tenant.update", exact: true })).toBeVisible();
  for (const path of [
    "/api/admin/providers",
    "/api/admin/provider-health",
    "/api/admin/provider-quotas",
    "/api/admin/runtime-settings",
    "/api/admin/combos",
    "/api/admin/client-keys",
    "/api/admin/budgets",
    "/api/admin/tenants",
    "/api/admin/identity-bindings",
    "/api/admin/audit-log",
  ]) {
    expect(calls.some((call) => call.path === path && call.csrf === "fixture-csrf")).toBe(true);
  }

  await page.route("**/api/admin/client-keys", (route) =>
    route.fulfill({
      json: {
        client_keys: [
          {
            id: "key-one",
            label: "Database",
            tenant_id: "red",
            created_by: "admin",
            model_id_format: "prefixed",
            enabled: true,
            expires_at_unix: null,
            access_schedule: null,
            scopes: [],
            allowed_endpoints: [],
            allowed_models: [],
            blocked_models: [],
            allowed_provider_ids: [],
            max_concurrent_requests: null,
            max_requests_per_minute: null,
            max_requests_per_day: null,
            max_tokens_per_minute: null,
            max_tokens_per_day: null,
            max_spend_per_month_usd: null,
            reservation_tokens: null,
            reservation_spend_usd: null,
            revision: "1",
          },
        ],
      },
    })
  );
  let created: Record<string, unknown> | null = null;
  await page.route("**/api/usage-sinks**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/types")) {
      await route.fulfill({
        json: {
          types: [
            {
              type: "webhook",
              label: "Webhook",
              description: "Signed usage",
              modes: ["instant", "window"],
              fields: [
                { key: "url", labelFallback: "Webhook URL", type: "text", required: true },
                {
                  key: "secret",
                  labelFallback: "Signing secret",
                  type: "password",
                  required: true,
                  secret: true,
                },
              ],
            },
            {
              type: "kafka",
              label: "Kafka",
              description: "Kafka usage",
              modes: ["instant", "window"],
              fields: [
                { key: "brokers", labelFallback: "Brokers", type: "text", required: true },
                { key: "topic", labelFallback: "Topic", type: "text", required: true },
                { key: "ssl", labelFallback: "Connect over TLS", type: "boolean" },
                {
                  key: "saslMechanism",
                  labelFallback: "SASL",
                  type: "select",
                  options: [
                    { value: "", labelFallback: "None" },
                    { value: "scram-sha-256", labelFallback: "SCRAM-SHA-256" },
                  ],
                },
              ],
            },
          ],
          windowSizesSec: [300, 900, 1800, 3600],
        },
      });
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
  await page.getByLabel("Delivery mode").selectOption("window");
  await page.getByLabel("Window size").selectOption("1800");
  await page.getByLabel("Limit to selected keys").check();
  await page.getByLabel("Database (key-one)").check();
  await page.getByRole("button", { name: "Save destination" }).click();
  await expect(page.getByRole("status")).toHaveText("Usage destination saved.");
  expect(created).toMatchObject({
    name: "Billing",
    type: "webhook",
    mode: "window",
    windowSec: 1800,
    apiKeyIds: ["key-one"],
    config: { url: "https://billing.example.com/usage", secret: "fixture-secret-123456789" },
  });

  await page.getByRole("button", { name: "Add destination" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Events");
  await page.getByLabel("Destination type").selectOption("kafka");
  await page.getByLabel("Brokers").fill("broker.example.com:9093");
  await page.getByLabel("Topic").fill("redrouter.usage");
  await page.getByLabel("Connect over TLS").check();
  await page.getByLabel("SASL").selectOption("scram-sha-256");
  await page.getByRole("button", { name: "Save destination" }).click();
  expect(created).toMatchObject({
    name: "Events",
    type: "kafka",
    mode: "instant",
    config: {
      brokers: "broker.example.com:9093",
      topic: "redrouter.usage",
      ssl: true,
      saslMechanism: "scram-sha-256",
    },
  });
});

test("static dashboard manages OIDC through Rust without exposing or clearing the saved secret", async ({
  page,
  context,
}) => {
  const calls: string[] = [];
  let saved: Record<string, unknown> | undefined;
  await context.addCookies([{ name: "redrouter_admin_csrf", value: "fixture-csrf", url: origin }]);
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    calls.push(path);
    if (path === "/api/auth/config") {
      await route.fulfill({
        json: {
          backend: "rust",
          control_plane_enabled: true,
          oidc_browser_login: true,
          password_login: false,
        },
      });
    } else if (path === "/api/admin/oidc/discover") {
      expect(request.headers()["x-red-router-csrf"]).toBe("fixture-csrf");
      await route.fulfill({
        json: {
          discovery: {
            issuer: "https://id.example",
            jwks_uri: "https://id.example/keys",
            authorization_endpoint: "https://id.example/authorize",
            token_endpoint: "https://id.example/token",
          },
        },
      });
    } else if (path === "/api/admin/oidc" && request.method() === "PUT") {
      expect(request.headers()["x-red-router-csrf"]).toBe("fixture-csrf");
      saved = request.postDataJSON();
      await route.fulfill({ json: { oidc: { browser: { has_client_secret: true } } } });
    } else if (path === "/api/admin/oidc") {
      await route.fulfill({
        json: {
          oidc: {
            enabled: true,
            issuer: "https://id.example",
            audience: "router",
            jwks_uri: "https://id.example/old-keys",
            required_claims: {},
            allowed_subjects: [],
            browser: {
              public_origin: origin,
              client_id: "router",
              authorization_endpoint: "https://id.example/authorize",
              token_endpoint: "https://id.example/token",
              scopes: ["openid"],
              has_client_secret: true,
            },
          },
        },
      });
    } else await route.fulfill({ status: 404, json: {} });
  });
  await page.goto(`${origin}/dashboard/oidc`);
  await expect(page.getByLabel("Client secret (leave blank to keep existing)")).toHaveValue("");
  await page.getByRole("button", { name: "Discover endpoints" }).click();
  await expect(page.getByLabel("JWKS URL")).toHaveValue("https://id.example/keys");
  await page.getByLabel("Allowed subjects (one per line)").fill("alice\nbob");
  await page.getByLabel("Required claims (JSON)").fill('{"groups":["admins"]}');
  await page.getByRole("button", { name: "Save OIDC settings" }).click();
  await expect(page.getByRole("status")).toContainText("Sign in again");
  expect(saved).toMatchObject({
    issuer: "https://id.example",
    jwks_uri: "https://id.example/keys",
    allowed_subjects: ["alice", "bob"],
    required_claims: { groups: ["admins"] },
    browser: { client_id: "router" },
  });
  expect((saved?.browser as Record<string, unknown>).client_secret).toBeUndefined();
  expect(calls).not.toContain("/api/settings");
});

test("static dashboard browses and refreshes the Rust models.dev catalog", async ({
  page,
  context,
}) => {
  await context.addCookies([{ name: "redrouter_admin_csrf", value: "fixture-csrf", url: origin }]);
  let refreshes = 0;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/auth/config")
      await route.fulfill({
        json: {
          backend: "rust",
          control_plane_enabled: true,
          oidc_browser_login: true,
          password_login: false,
        },
      });
    else if (path === "/api/admin/model-catalog/refresh") {
      expect(request.headers()["x-red-router-csrf"]).toBe("fixture-csrf");
      refreshes++;
      await route.fulfill({ json: { snapshot: { changed: true } } });
    } else if (path === "/api/admin/model-catalog") {
      await route.fulfill({
        json: {
          manifest: { fetchedAt: "2026-01-01", providers: 1, providerModels: 2 },
          snapshot: { source: "models.dev" },
          providers: [{ id: "example", name: "Example" }],
        },
      });
    } else if (path === "/api/admin/model-catalog/example") {
      await route.fulfill({
        json: {
          provider: {
            id: "example",
            models: [
              {
                id: "alpha",
                limit: { context: 128000, output: 4096 },
                cost: { input: 1.25, output: 3 },
                modalities: { input: ["text", "image"], output: ["text"] },
                tool_call: true,
              },
              { id: "beta" },
            ],
          },
        },
      });
    } else await route.fulfill({ status: 404, json: {} });
  });
  await page.goto(`${origin}/dashboard/model-catalog`);
  await expect(page.getByLabel("Provider", { exact: true })).toBeVisible({ timeout: 10_000 });
  await page.getByLabel("Provider", { exact: true }).selectOption("example");
  await expect(page.getByText("128,000")).toBeVisible();
  await expect(page.getByText("$1.25")).toBeVisible();
  await page.getByLabel("Filter models").fill("alpha");
  await expect(page.getByText("beta")).not.toBeVisible();
  await page.getByRole("button", { name: "Refresh catalog" }).click();
  await expect(page.getByRole("status")).toHaveText("Catalog updated.");
  expect(refreshes).toBe(1);
});

test("static dashboard reads staged historical costs from the Rust API", async ({
  page,
  context,
}) => {
  await context.addCookies([{ name: "redrouter_admin_csrf", value: "fixture-csrf", url: origin }]);
  const queries: string[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/auth/config") {
      await route.fulfill({
        json: {
          backend: "rust",
          control_plane_enabled: true,
          oidc_browser_login: true,
          password_login: false,
        },
      });
    } else if (url.pathname === "/api/admin/legacy-usage") {
      expect(request.headers()["x-red-router-csrf"]).toBe("fixture-csrf");
      queries.push(url.search);
      const second = url.searchParams.has("cursor");
      await route.fulfill({
        json: {
          legacy_usage: {
            available: true,
            next_cursor: second ? null : "12",
            entries: [
              {
                row_id: second ? "11" : "12",
                key_id: "key-a",
                tenant_id: "acme",
                provider: "openai",
                model: "gpt",
                timestamp: "2026-01-01T00:00:00Z",
                tokens_input: "10",
                tokens_output: "5",
                tokens_reasoning: "1",
                amount_usd: 0.00000031,
                pricing_known: true,
                success: true,
              },
            ],
          },
        },
      });
    } else await route.fulfill({ status: 404, json: {} });
  });
  await page.goto(`${origin}/dashboard/legacy-usage`);
  await expect(page.getByRole("heading", { name: "Historical usage" })).toBeVisible();
  await expect(page.getByText("$3.1e-7")).toBeVisible();
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(page.getByRole("button", { name: "First page" })).toBeVisible();
  expect(queries.some((query) => new URLSearchParams(query).get("cursor") === "12")).toBe(true);
});
