import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

// Real database on a scratch install. JWT_SECRET is fixed so a dashboard session can be minted.
const dataDir = mkdtempSync(join(tmpdir(), "redrouter-prometheus-"));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = "test-jwt-secret-for-prometheus-metrics";

const { getDbInstance, resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { updateSettings, getSettings } = await import("../../../src/lib/db/settings.ts");
const { hashManagementPassword } = await import("../../../src/lib/auth/managementPassword.ts");
const { DASHBOARD_SESSION_COOKIE, getDashboardJwtSecret, mintDashboardSessionToken } = await import(
  "../../../src/shared/utils/dashboardSessionToken.ts"
);
const { getCircuitBreaker, resetAllCircuitBreakers } = await import(
  "../../../src/shared/utils/circuitBreaker.ts"
);
const text = await import("../../../src/lib/metrics/prometheusText.ts");
const collect = await import("../../../src/lib/metrics/collect.ts");
const metricsRoute = await import("../../../src/app/api/metrics/route.ts");
const tokenRoute = await import("../../../src/app/api/metrics/token/route.ts");
const settingsRoute = await import("../../../src/app/api/settings/route.ts");
const { PUBLIC_API_ROUTES_EXACT, isPublicApiRoute } = await import(
  "../../../src/shared/constants/publicApiRoutes.ts"
);

const PASSWORD = "correct horse battery staple 42";

after(() => {
  resetAllCircuitBreakers();
  resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

// --- 1. renderer ------------------------------------------------------------------------------

const emptySnapshot = (): import("../../../src/lib/metrics/prometheusText.ts").MetricsSnapshot => ({
  requests: [],
  tokens: [],
  costUsd: [],
  latency: [],
  breakers: [],
  connections: [],
  version: "1.2.3",
  uptimeSeconds: 42,
});

test("label values escape backslash, quote and newline; HELP escapes backslash and newline", () => {
  assert.equal(text.escapeLabelValue('a\\b"c\nd'), 'a\\\\b\\"c\\nd');
  assert.equal(text.escapeHelp('x\\y\nz"'), 'x\\\\y\\nz"');
  const out = text.renderPrometheusText({
    ...emptySnapshot(),
    requests: [{ provider: 'p"q', model: "m\\n\nx", statusClass: "2xx", count: 3 }],
  });
  assert.match(out, /redrouter_requests_total\{provider="p\\"q",model="m\\\\n\\nx",status_class="2xx"\} 3\n/);
  // No raw newline may survive inside a sample line.
  for (const line of out.split("\n")) assert.ok(!line.includes("\r"));
});

test("every family has exactly one HELP and one TYPE line, in that order", () => {
  const out = text.renderPrometheusText(emptySnapshot());
  const families = [
    ["redrouter_requests_total", "counter"],
    ["redrouter_tokens_total", "counter"],
    ["redrouter_cost_usd_total", "counter"],
    ["redrouter_request_duration_seconds", "histogram"],
    ["redrouter_circuit_breaker_state", "gauge"],
    ["redrouter_connections", "gauge"],
    ["redrouter_build_info", "gauge"],
    ["redrouter_uptime_seconds", "gauge"],
  ];
  const lines = out.split("\n");
  for (const [name, type] of families) {
    const help = lines.filter((line) => line.startsWith(`# HELP ${name} `));
    const typeLines = lines.filter((line) => line === `# TYPE ${name} ${type}`);
    assert.equal(help.length, 1, `${name} HELP`);
    assert.equal(typeLines.length, 1, `${name} TYPE`);
    assert.ok(lines.indexOf(help[0]) < lines.indexOf(typeLines[0]), `${name} order`);
  }
  assert.ok(out.endsWith("\n"));
  assert.match(out, /redrouter_build_info\{version="1.2.3"\} 1\n/);
  assert.match(out, /redrouter_uptime_seconds 42\n/);
});

test("the histogram is cumulative and its +Inf bucket, _count and _sum agree", () => {
  const bounds = text.REQUEST_DURATION_BUCKETS_SECONDS;
  const buckets = bounds.map((_, index) => index + 1); // 1,2,3... cumulative and non-decreasing
  const count = buckets[buckets.length - 1] + 4;
  const out = text.renderPrometheusText({
    ...emptySnapshot(),
    latency: [{ provider: "p", model: "m", buckets, sumSeconds: 12.5, count }],
  });
  const values = [...out.matchAll(/redrouter_request_duration_seconds_bucket\{provider="p",model="m",le="([^"]+)"\} (\S+)/g)];
  assert.equal(values.length, bounds.length + 1);
  assert.equal(values[values.length - 1][1], "+Inf");
  let previous = -1;
  for (const [, , value] of values) {
    assert.ok(Number(value) >= previous, "buckets never decrease");
    previous = Number(value);
  }
  assert.equal(Number(values[values.length - 1][2]), count);
  assert.match(out, new RegExp(`redrouter_request_duration_seconds_count\\{provider="p",model="m"\\} ${count}\\n`));
  assert.match(out, /redrouter_request_duration_seconds_sum\{provider="p",model="m"\} 12\.5\n/);
});

test("the breaker gauge is a state set: one 1 among the four states", () => {
  const out = text.renderPrometheusText({
    ...emptySnapshot(),
    breakers: [{ provider: "openai", state: "OPEN" }],
  });
  for (const state of text.CIRCUIT_BREAKER_STATES) {
    const expected = state === "OPEN" ? 1 : 0;
    assert.ok(
      out.includes(`redrouter_circuit_breaker_state{provider="openai",state="${state}"} ${expected}\n`),
      state
    );
  }
});

// --- shared fixtures --------------------------------------------------------------------------

function seedUsage(
  rows: {
    provider: string;
    model: string;
    status: string | number;
    success?: number;
    latencyMs: number;
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  }[]
) {
  const db = getDbInstance();
  const insert = db.prepare(
    `INSERT INTO usage_history (provider, model, tokens_input, tokens_output, tokens_cache_read,
       tokens_cache_creation, status, success, latency_ms, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const row of rows) {
    insert.run(
      row.provider,
      row.model,
      row.input ?? 0,
      row.output ?? 0,
      row.cacheRead ?? 0,
      row.cacheWrite ?? 0,
      row.status,
      row.success ?? 1,
      row.latencyMs,
      new Date().toISOString()
    );
  }
}

function seedCost(rows: { provider: string; model: string; amount: number }[]) {
  const insert = getDbInstance().prepare(
    `INSERT INTO request_cost_ledger (api_key_id, provider, model, amount_usd, timestamp)
     VALUES ('key-secret-id', ?, ?, ?, ?)`
  );
  for (const row of rows) insert.run(row.provider, row.model, row.amount, new Date().toISOString());
}

function resetData() {
  const db = getDbInstance();
  db.prepare("DELETE FROM usage_history").run();
  db.prepare("DELETE FROM request_cost_ledger").run();
  collect.resetMetricsCache();
}

const sample = (out: string, name: string, labels: Record<string, string>): number | undefined => {
  const wanted = Object.entries(labels).map(([k, v]) => `${k}="${v}"`);
  for (const line of out.split("\n")) {
    if (!line.startsWith(`${name}{`)) continue;
    if (wanted.every((part) => line.includes(part))) return Number(line.slice(line.lastIndexOf(" ") + 1));
  }
  return undefined;
};

// --- 3. collector -----------------------------------------------------------------------------

beforeEach(async () => {
  resetData();
  resetAllCircuitBreakers();
});

test("counters equal the seeded totals and status classes come from the recorded status", async () => {
  seedUsage([
    { provider: "openai", model: "gpt-x", status: 200, latencyMs: 300, input: 10, output: 5, cacheRead: 2, cacheWrite: 1 },
    { provider: "openai", model: "gpt-x", status: "200", latencyMs: 1500, input: 20, output: 7 },
    { provider: "openai", model: "gpt-x", status: 429, success: 0, latencyMs: 50 },
    { provider: "openai", model: "gpt-x", status: 503, success: 0, latencyMs: 130_000 },
    { provider: "anthropic", model: "claude-y", status: null as never, success: 0, latencyMs: 10 },
  ]);
  seedCost([
    { provider: "openai", model: "gpt-x", amount: 0.25 },
    { provider: "openai", model: "gpt-x", amount: 0.5 },
  ]);
  const out = await collect.renderMetrics();
  const l = { provider: "openai", model: "gpt-x" };
  assert.equal(sample(out, "redrouter_requests_total", { ...l, status_class: "2xx" }), 2);
  assert.equal(sample(out, "redrouter_requests_total", { ...l, status_class: "4xx" }), 1);
  assert.equal(sample(out, "redrouter_requests_total", { ...l, status_class: "5xx" }), 1);
  assert.equal(
    sample(out, "redrouter_requests_total", { provider: "anthropic", model: "claude-y", status_class: "error" }),
    1
  );
  assert.equal(sample(out, "redrouter_tokens_total", { ...l, direction: "input" }), 30);
  assert.equal(sample(out, "redrouter_tokens_total", { ...l, direction: "output" }), 12);
  assert.equal(sample(out, "redrouter_tokens_total", { ...l, direction: "cache_read" }), 2);
  assert.equal(sample(out, "redrouter_tokens_total", { ...l, direction: "cache_write" }), 1);
  assert.equal(sample(out, "redrouter_cost_usd_total", l), 0.75);
  // latency: 4 openai rows (0.3s, 1.5s, 0.05s, 130s); 130s exceeds the largest finite bucket
  assert.equal(sample(out, "redrouter_request_duration_seconds_count", l), 4);
  assert.equal(sample(out, "redrouter_request_duration_seconds_bucket", { ...l, le: "0.1" }), 1);
  assert.equal(sample(out, "redrouter_request_duration_seconds_bucket", { ...l, le: "0.5" }), 2);
  assert.equal(sample(out, "redrouter_request_duration_seconds_bucket", { ...l, le: "2.5" }), 3);
  assert.equal(sample(out, "redrouter_request_duration_seconds_bucket", { ...l, le: "120" }), 3);
  assert.equal(sample(out, "redrouter_request_duration_seconds_bucket", { ...l, le: "+Inf" }), 4);
  assert.equal(sample(out, "redrouter_request_duration_seconds_sum", l), (300 + 1500 + 50 + 130_000) / 1000);
});

test("counters stay monotonic across scrapes and the aggregate is cached between them", async () => {
  seedUsage([{ provider: "p1", model: "m1", status: 200, latencyMs: 100, input: 5 }]);
  const first = await collect.renderMetrics({ now: 1_000_000 });
  seedUsage([{ provider: "p1", model: "m1", status: 200, latencyMs: 100, input: 5 }]);
  const cachedScrape = await collect.renderMetrics({ now: 1_000_000 + 5_000 });
  assert.equal(
    sample(cachedScrape, "redrouter_requests_total", { provider: "p1" }),
    sample(first, "redrouter_requests_total", { provider: "p1" }),
    "a scrape inside the cache window reuses the aggregate"
  );
  const second = await collect.renderMetrics({ now: 1_000_000 + collect.AGGREGATE_CACHE_TTL_MS + 1 });
  const a = sample(first, "redrouter_requests_total", { provider: "p1" }) as number;
  const b = sample(second, "redrouter_requests_total", { provider: "p1" }) as number;
  assert.equal(a, 1);
  assert.equal(b, 2);
  assert.ok(b >= a);
  assert.equal(sample(second, "redrouter_tokens_total", { provider: "p1", direction: "input" }), 10);
});

test("the cardinality cap keeps the busiest pairs and folds the tail into model=other", () => {
  const usage = [] as import("../../../src/lib/db/metricsAggregates.ts").UsageAggregateRow[];
  const row = (provider: string, model: string, requests: number) => ({
    provider,
    model,
    statusClass: "2xx",
    requests,
    tokensInput: requests * 10,
    tokensOutput: 0,
    tokensCacheRead: 0,
    tokensCacheWrite: 0,
    latencyMsSum: requests * 100,
    latencyBuckets: text.REQUEST_DURATION_BUCKETS_SECONDS.map(() => requests),
  });
  usage.push(row("p", "busy-1", 100), row("p", "busy-2", 90), row("p", "rare-a", 2), row("p", "rare-b", 1));
  usage.push(row("q", "rare-c", 3));
  const folded = collect.foldAggregates(
    usage,
    [
      { provider: "p", model: "rare-a", costUsd: 1 },
      { provider: "p", model: "rare-b", costUsd: 2 },
      { provider: "p", model: "busy-1", costUsd: 4 },
    ],
    2
  );
  const models = new Set(folded.requests.map((r) => `${r.provider}/${r.model}`));
  assert.deepEqual([...models].sort(), ["p/busy-1", "p/busy-2", "p/other", "q/other"]);
  const other = folded.requests.find((r) => r.provider === "p" && r.model === "other");
  assert.equal(other?.count, 3);
  assert.equal(folded.costUsd.find((c) => c.provider === "p" && c.model === "other")?.value, 3);
  assert.equal(folded.costUsd.find((c) => c.provider === "p" && c.model === "busy-1")?.value, 4);
  const otherLatency = folded.latency.find((l) => l.provider === "p" && l.model === "other");
  assert.equal(otherLatency?.count, 3);
  assert.equal(otherLatency?.buckets[0], 3);
  // Total requests are conserved by the fold.
  assert.equal(
    folded.requests.reduce((sum, r) => sum + r.count, 0),
    usage.reduce((sum, r) => sum + r.requests, 0)
  );
});

test("the breaker gauge follows a forced OPEN breaker and hides per-connection breakers", async () => {
  const breaker = getCircuitBreaker("metrics-prov", { failureThreshold: 1, resetTimeout: 60_000 });
  await breaker.execute(async () => {
    throw new Error("upstream down");
  }).catch(() => undefined);
  getCircuitBreaker("metrics-prov::conn::secret-connection-id");
  getCircuitBreaker("metrics-healthy");
  const out = await collect.renderMetrics();
  assert.equal(sample(out, "redrouter_circuit_breaker_state", { provider: "metrics-prov", state: "OPEN" }), 1);
  assert.equal(sample(out, "redrouter_circuit_breaker_state", { provider: "metrics-prov", state: "CLOSED" }), 0);
  assert.equal(sample(out, "redrouter_circuit_breaker_state", { provider: "metrics-healthy", state: "CLOSED" }), 1);
  assert.ok(!out.includes("secret-connection-id"));
});

test("connections are counted per provider and status without exposing names or ids", async () => {
  const db = getDbInstance();
  const insert = db.prepare(
    `INSERT INTO provider_connections (id, provider, auth_type, name, email, is_active, test_status,
       rate_limited_until, created_at, updated_at)
     VALUES (?, ?, 'apikey', ?, ?, ?, ?, ?, ?, ?)`
  );
  const now = new Date().toISOString();
  const future = new Date(Date.now() + 60_000).toISOString();
  insert.run("conn-1", "openai", "Personal Key", "me@example.com", 1, "active", null, now, now);
  insert.run("conn-2", "openai", "Team Key", "team@example.com", 1, "unavailable", future, now, now);
  insert.run("conn-3", "openai", "Old Key", null, 0, "active", null, now, now);
  insert.run("conn-4", "openai", "Banned Key", null, 1, "banned", null, now, now);
  collect.resetMetricsCache();
  const out = await collect.renderMetrics();
  assert.equal(sample(out, "redrouter_connections", { provider: "openai", status: "active" }), 1);
  assert.equal(sample(out, "redrouter_connections", { provider: "openai", status: "unavailable" }), 2);
  assert.equal(sample(out, "redrouter_connections", { provider: "openai", status: "disabled" }), 1);
  for (const secret of ["Personal Key", "me@example.com", "conn-1", "team@example.com"]) {
    assert.ok(!out.includes(secret), secret);
  }
  db.prepare("DELETE FROM provider_connections").run();
});

// --- 2. route ---------------------------------------------------------------------------------

async function sessionCookie() {
  const token = await mintDashboardSessionToken(getDashboardJwtSecret());
  return `${DASHBOARD_SESSION_COOKIE}=${token}`;
}

const get = (headers: Record<string, string> = {}) =>
  metricsRoute.GET(new Request("http://localhost/api/metrics", { headers }));

async function post(route: { POST: (r: Request) => Promise<Response> }, body: unknown = {}) {
  return route.POST(
    new Request("http://localhost/api/metrics/token", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: await sessionCookie() },
      body: JSON.stringify(body),
    })
  );
}

async function lockedInstall(enabled: boolean) {
  await updateSettings({
    requireLogin: true,
    password: await hashManagementPassword(PASSWORD),
    prometheusMetricsEnabled: enabled,
  });
}

test("the endpoint is off by default and answers a fixed 404", async () => {
  await lockedInstall(false);
  const response = await get();
  assert.equal(response.status, 404);
  const body = await response.text();
  assert.doesNotMatch(body, /redrouter_/);
  // Off means off, even for an authenticated caller.
  assert.equal((await get({ cookie: await sessionCookie() })).status, 404);
  assert.equal((await getSettings()).prometheusMetricsEnabled, false);
});

test("the route is public only in the sense of skipping the cookie gate; the token route is not", () => {
  assert.ok(PUBLIC_API_ROUTES_EXACT.has("/api/metrics"));
  assert.equal(isPublicApiRoute("/api/metrics", "GET"), true);
  assert.equal(isPublicApiRoute("/api/metrics/token", "POST"), false);
});

test("enabled: 401 without credentials, 200 with a management session", async () => {
  await lockedInstall(true);
  seedUsage([{ provider: "openai", model: "gpt-x", status: 200, latencyMs: 100, input: 3 }]);
  const anonymous = await get();
  assert.equal(anonymous.status, 401);
  assert.doesNotMatch(await anonymous.text(), /redrouter_/);

  const ok = await get({ cookie: await sessionCookie() });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "text/plain; version=0.0.4; charset=utf-8");
  assert.equal(ok.headers.get("cache-control"), "no-store");
  const body = await ok.text();
  assert.match(body, /^# HELP redrouter_requests_total /m);
  assert.match(body, /redrouter_build_info\{version="[^"]+"\} 1/);
});

test("with requireLogin off a management session is implicit", async () => {
  await updateSettings({ requireLogin: false, password: "", prometheusMetricsEnabled: true });
  assert.equal((await get()).status, 200);
});

test("the scrape token: minted server-side once, accepted as a bearer, wrong ones refused", async () => {
  await lockedInstall(true);

  // Minting needs a management session and the current password.
  const anonymous = await tokenRoute.POST(
    new Request("http://localhost/api/metrics/token", { method: "POST", body: "{}" })
  );
  assert.equal(anonymous.status, 401);
  assert.equal((await post(tokenRoute)).status, 400, "the current password is required");
  assert.equal((await post(tokenRoute, { currentPassword: "nope" })).status, 401);

  const minted = await post(tokenRoute, { currentPassword: PASSWORD });
  assert.equal(minted.status, 200);
  const { token } = (await minted.json()) as { token: string };
  assert.match(token, /^rrm_[A-Za-z0-9_-]{43}$/);

  const withBearer = await get({ authorization: `Bearer ${token}` });
  assert.equal(withBearer.status, 200);
  assert.match(await withBearer.text(), /# TYPE redrouter_uptime_seconds gauge/);

  assert.equal((await get({ authorization: `Bearer ${token}x` })).status, 401);
  assert.equal((await get({ authorization: "Bearer rrm_wrong" })).status, 401);
  assert.equal((await get({ authorization: `Basic ${token}` })).status, 401);

  // The token is stored encrypted-at-rest / hidden: never readable through any GET.
  const cookie = await sessionCookie();
  const status = await tokenRoute.GET(
    new Request("http://localhost/api/metrics/token", { headers: { cookie } })
  );
  const statusText = await status.text();
  assert.equal(JSON.parse(statusText).hasToken, true);
  assert.ok(!statusText.includes(token));
  const settingsText = await (
    await settingsRoute.GET(new Request("http://localhost/api/settings", { headers: { cookie } }))
  ).text();
  assert.ok(!settingsText.includes(token), "GET /api/settings never carries the token");
  assert.ok(!settingsText.includes("_prometheusMetricsToken"));
  const scrape = await (await get({ authorization: `Bearer ${token}` })).text();
  assert.ok(!scrape.includes(token), "the scrape never carries the token");

  // A regenerated token replaces the old one.
  const second = (await (await post(tokenRoute, { currentPassword: PASSWORD })).json()) as { token: string };
  assert.notEqual(second.token, token);
  assert.equal((await get({ authorization: `Bearer ${token}` })).status, 401);
  assert.equal((await get({ authorization: `Bearer ${second.token}` })).status, 200);

  // Revoking stops bearer scraping.
  const revoked = await tokenRoute.DELETE(
    new Request("http://localhost/api/metrics/token", {
      method: "DELETE",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ currentPassword: PASSWORD }),
    })
  );
  assert.equal(revoked.status, 200);
  assert.equal((await get({ authorization: `Bearer ${second.token}` })).status, 401);
});

test("a bearer token does not open the endpoint while it is switched off", async () => {
  await lockedInstall(true);
  const { token } = (await (await post(tokenRoute, { currentPassword: PASSWORD })).json()) as { token: string };
  await updateSettings({ prometheusMetricsEnabled: false });
  assert.equal((await get({ authorization: `Bearer ${token}` })).status, 404);
});

test("enabling the endpoint through the settings API needs the current password", async () => {
  await lockedInstall(false);
  const cookie = await sessionCookie();
  const patch = (body: unknown) =>
    settingsRoute.PATCH(
      new Request("http://localhost/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify(body),
      })
    );
  assert.equal((await patch({ prometheusMetricsEnabled: true })).status, 400);
  assert.equal((await patch({ prometheusMetricsEnabled: true, currentPassword: "wrong" })).status, 401);
  assert.equal((await getSettings()).prometheusMetricsEnabled, false);
  const ok = await patch({ prometheusMetricsEnabled: true, currentPassword: PASSWORD });
  assert.equal(ok.status, 200);
  assert.equal((await getSettings()).prometheusMetricsEnabled, true);
});

test("a client cannot choose the token through the settings API", async () => {
  await lockedInstall(true);
  const cookie = await sessionCookie();
  const response = await settingsRoute.PATCH(
    new Request("http://localhost/api/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ prometheusMetricsToken: "rrm_chosen", currentPassword: PASSWORD }),
    })
  );
  assert.ok([200, 400].includes(response.status));
  assert.equal((await getSettings() as Record<string, unknown>).prometheusMetricsToken, undefined);
  assert.equal((await get({ authorization: "Bearer rrm_chosen" })).status, 401);
});
