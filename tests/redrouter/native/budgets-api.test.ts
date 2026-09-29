import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// Real database on a scratch install. JWT_SECRET is fixed so a dashboard session can be minted.
const dataDir = mkdtempSync(join(tmpdir(), "redrouter-budgets-api-"));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = "test-jwt-secret-for-budgets-api";
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "budgets-api-test-secret";

const { getDbInstance, resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { updateSettings } = await import("../../../src/lib/db/settings.ts");
const { hashManagementPassword } = await import("../../../src/lib/auth/managementPassword.ts");
const { DASHBOARD_SESSION_COOKIE, getDashboardJwtSecret, mintDashboardSessionToken } =
  await import("../../../src/shared/utils/dashboardSessionToken.ts");
const repo = await import("../../../src/lib/db/budgets.ts");
const engine = await import("../../../src/domain/budgetEngine.ts");
const costRules = await import("../../../src/domain/costRules.ts");
const policy = await import("../../../src/lib/usage/meteredBudgetPolicy.ts");
const webhooks = await import("../../../src/lib/db/webhooks.ts");
const listRoute = await import("../../../src/app/api/budgets/route.ts");
const itemRoute = await import("../../../src/app/api/budgets/[id]/route.ts");
const assignRoute = await import("../../../src/app/api/budgets/[id]/assignments/route.ts");
const { EVENT_DESCRIPTIONS, WEBHOOK_EVENT_VALUES } =
  await import("../../../src/lib/webhooks/eventDescriptions.ts");

const METERED = "openai";
const FLAT_RATE = "opencode-go";

after(() => {
  engine.setBudgetWarningNotifier(null);
  resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

async function sessionCookie() {
  const token = await mintDashboardSessionToken(getDashboardJwtSecret());
  return `${DASHBOARD_SESSION_COOKIE}=${token}`;
}

async function call(
  handler: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>,
  method: string,
  id: string,
  body?: unknown,
  authenticated = true
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (authenticated) headers.cookie = await sessionCookie();
  return handler(
    new Request(`http://localhost/api/budgets/${id}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  );
}

const post = async (body: unknown, authenticated = true) =>
  listRoute.POST(
    new Request("http://localhost/api/budgets", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authenticated ? { cookie: await sessionCookie() } : {}),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  );

const list = async (authenticated = true) =>
  listRoute.GET(
    new Request("http://localhost/api/budgets", {
      headers: authenticated ? { cookie: await sessionCookie() } : {},
    })
  );

// --- API --------------------------------------------------------------------------------------

test("every handler refuses a caller without a management session", async () => {
  await updateSettings({
    requireLogin: true,
    password: await hashManagementPassword("correct horse battery staple 42"),
  });
  assert.equal((await list(false)).status, 401);
  assert.equal((await post({ name: "x", maxUsd: 5 }, false)).status, 401);
  assert.equal((await call(itemRoute.GET, "GET", "any", undefined, false)).status, 401);
  assert.equal((await call(itemRoute.PATCH, "PATCH", "any", { name: "y" }, false)).status, 401);
  assert.equal((await call(itemRoute.DELETE, "DELETE", "any", undefined, false)).status, 401);
  assert.equal((await call(assignRoute.GET, "GET", "any", undefined, false)).status, 401);
  assert.equal((await call(assignRoute.PUT, "PUT", "any", { keyIds: [] }, false)).status, 401);
  assert.equal((await list()).status, 200, "a management session gets through");
});

test("creation validates its input with fixed messages", async () => {
  const invalid: unknown[] = [
    {},
    { name: "", maxUsd: 5 },
    { name: "x".repeat(81), maxUsd: 5 },
    { name: "x", maxUsd: 0 },
    { name: "x", maxUsd: -1 },
    { name: "x", maxUsd: "5" },
    { name: "x", maxUsd: 5, softUsd: 6 },
    { name: "x", maxUsd: 5, duration: "hourly" },
    { name: "x", maxUsd: 5, resetTime: "25:00" },
    { name: "x", maxUsd: 5, onExceed: "drop" },
    { name: "x", maxUsd: 5, throttleDelayMs: -1 },
    { name: "x", maxUsd: 5, tpm: 100 },
  ];
  for (const body of invalid) {
    const response = await post(body);
    assert.equal(response.status, 400, JSON.stringify(body));
    const payload = await response.json();
    assert.equal(payload.error.message, "Invalid request");
    assert.ok(Array.isArray(payload.error.details));
  }
  assert.equal((await post("{not json")).status, 400);
  assert.equal((await (await list()).json()).budgets.length, 0, "nothing was created");
});

test("create, read, update, assign and delete round-trip", async () => {
  const created = await post({
    name: "Team monthly",
    maxUsd: 100,
    softUsd: 60,
    duration: "monthly",
    resetTime: "06:30",
    onExceed: "throttle",
    throttleDelayMs: 750,
    keyIds: ["key-a"],
    groupIds: ["group-a"],
  });
  assert.equal(created.status, 201);
  const { budget } = await created.json();
  assert.equal(budget.name, "Team monthly");
  assert.equal(budget.maxUsd, 100);
  assert.equal(budget.softUsd, 60);
  assert.equal(budget.onExceed, "throttle");
  assert.equal(budget.throttleDelayMs, 750);
  assert.equal(budget.enabled, true);
  assert.deepEqual(budget.keyIds, ["key-a"]);
  assert.deepEqual(budget.groupIds, ["group-a"]);
  assert.equal(budget.usage.spentUsd, 0);
  assert.ok(budget.usage.resetAt, "a monthly budget reports when its window ends");

  const fetched = await (await call(itemRoute.GET, "GET", budget.id)).json();
  assert.equal(fetched.budget.id, budget.id);

  const patched = await call(itemRoute.PATCH, "PATCH", budget.id, {
    name: "Team monthly (renamed)",
    enabled: false,
    softUsd: null,
  });
  assert.equal(patched.status, 200);
  const patchedBudget = (await patched.json()).budget;
  assert.equal(patchedBudget.name, "Team monthly (renamed)");
  assert.equal(patchedBudget.enabled, false);
  assert.equal(patchedBudget.softUsd, null);
  assert.equal(patchedBudget.effectiveSoftUsd, 80);
  assert.equal(patchedBudget.maxUsd, 100);

  // The invariant is checked against the stored value too.
  await call(itemRoute.PATCH, "PATCH", budget.id, { softUsd: 50 });
  const tooLow = await call(itemRoute.PATCH, "PATCH", budget.id, { maxUsd: 40 });
  assert.equal(tooLow.status, 400);
  assert.equal((await call(itemRoute.PATCH, "PATCH", budget.id, {})).status, 400);
  assert.equal((await call(itemRoute.PATCH, "PATCH", budget.id, { bogus: 1 })).status, 400);

  const assigned = await call(assignRoute.PUT, "PUT", budget.id, {
    keyIds: ["key-b", "key-c", "key-b"],
    groupIds: [],
  });
  assert.equal(assigned.status, 200);
  assert.deepEqual(await assigned.json(), { keyIds: ["key-b", "key-c"], groupIds: [] });
  assert.deepEqual(await (await call(assignRoute.GET, "GET", budget.id)).json(), {
    keyIds: ["key-b", "key-c"],
    groupIds: [],
  });
  assert.equal((await call(assignRoute.PUT, "PUT", budget.id, { keyIds: "nope" })).status, 400);

  assert.equal((await call(itemRoute.GET, "GET", "missing")).status, 404);
  assert.equal((await call(itemRoute.PATCH, "PATCH", "missing", { name: "x" })).status, 404);
  assert.equal((await call(assignRoute.PUT, "PUT", "missing", { keyIds: [] })).status, 404);
  assert.equal((await call(assignRoute.GET, "GET", "missing")).status, 404);
  assert.equal((await call(itemRoute.DELETE, "DELETE", "missing")).status, 404);

  assert.equal((await call(itemRoute.DELETE, "DELETE", budget.id)).status, 200);
  assert.equal((await call(itemRoute.GET, "GET", budget.id)).status, 404);
  assert.equal((await (await list()).json()).budgets.length, 0);
});

test("the list carries the spend of the current window", async () => {
  const { budget } = await (
    await post({ name: "Listed", maxUsd: 10, keyIds: ["key-list"] })
  ).json();
  costRules.recordCost("key-list", 2.5, { provider: METERED });
  costRules.recordCost("key-list", 1, { provider: FLAT_RATE });

  const listed = (await (await list()).json()).budgets.find(
    (entry: { id: string }) => entry.id === budget.id
  );
  assert.equal(listed.usage.spentUsd, 2.5, "the flat-rate call is not counted");
  assert.deepEqual(listed.keyIds, ["key-list"]);
  await call(itemRoute.DELETE, "DELETE", budget.id);
});

// --- pre-dispatch gate ------------------------------------------------------------------------

test("a blocked budget refuses the request with 429 budget_exceeded and the retry instant", async () => {
  const { budget } = await (
    await post({ name: "Gate cap", maxUsd: 1, duration: "daily", keyIds: ["key-gate"] })
  ).json();
  assert.equal(await policy.rejectIfMeteredBudgetExceeded("key-gate", METERED, "openai/x"), null);

  costRules.recordCost("key-gate", 1.5, { provider: METERED });
  const response = await policy.rejectIfMeteredBudgetExceeded("key-gate", METERED, "openai/x");
  assert.ok(response, "the spent budget refuses the request");
  assert.equal(response.status, 429);
  const body = await response.json();
  assert.equal(body.error.code, "BUDGET_EXCEEDED");
  assert.match(body.error.message, /Gate cap/);
  assert.ok(body.error.retry_after > 0);
  assert.ok(body.error.reset_at);
  assert.equal(response.headers.get("X-RedRouter-Reason"), "api_key_limit");
  assert.ok(Number(response.headers.get("Retry-After")) > 0);
  assert.doesNotMatch(JSON.stringify(body), /at \/|node_modules/);

  // The budget covers metered usage only; another key and a flat-rate provider go through.
  assert.equal(
    await policy.rejectIfMeteredBudgetExceeded("key-gate", FLAT_RATE, "opencode-go/x"),
    null
  );
  assert.equal(await policy.rejectIfMeteredBudgetExceeded("other-key", METERED, "openai/x"), null);
  assert.equal(await policy.rejectIfMeteredBudgetExceeded(null, METERED, "openai/x"), null);
  await call(itemRoute.DELETE, "DELETE", budget.id);
});

test("a throttle budget delays the request and lets it through", async () => {
  const { budget } = await (
    await post({
      name: "Slow lane",
      maxUsd: 1,
      onExceed: "throttle",
      throttleDelayMs: 60,
      keyIds: ["key-slow"],
    })
  ).json();
  costRules.recordCost("key-slow", 2, { provider: METERED });

  const decision = policy.checkMeteredBudgetForProvider("key-slow", METERED, "openai/x");
  assert.equal(decision.allowed, true);
  assert.equal(decision.delayMs, 60);

  const started = Date.now();
  assert.equal(await policy.rejectIfMeteredBudgetExceeded("key-slow", METERED, "openai/x"), null);
  assert.ok(Date.now() - started >= 55, "the request waited for the throttle delay");
  await call(itemRoute.DELETE, "DELETE", budget.id);
});

test("the per-key budget still blocks on its own, next to the reusable budgets", async () => {
  const { budget } = await (
    await post({ name: "Roomy", maxUsd: 1000, keyIds: ["key-both"] })
  ).json();
  costRules.resetCostData();
  costRules.setBudget("key-both", { dailyLimitUsd: 1, resetInterval: "daily" });
  costRules.recordCost("key-both", 2, { provider: METERED });

  // The reusable budget has plenty of room; the per-key one refuses.
  assert.equal(engine.checkBudgets({ keyId: "key-both", provider: METERED }).state, "ok");
  const response = await policy.rejectIfMeteredBudgetExceeded("key-both", METERED, "openai/x");
  assert.equal(response?.status, 429);
  assert.equal(
    await policy.rejectIfMeteredBudgetExceeded("key-both", FLAT_RATE, "opencode-go/x"),
    null,
    "the flat-rate exemption of the per-key budget is unchanged"
  );

  // And the other way round: no per-key budget, the reusable one refuses.
  costRules.deleteBudget("key-both");
  assert.equal(await policy.rejectIfMeteredBudgetExceeded("key-both", METERED, "openai/x"), null);
  await call(assignRoute.PUT, "PUT", budget.id, { keyIds: ["key-both"] });
  await call(itemRoute.PATCH, "PATCH", budget.id, { maxUsd: 1, softUsd: null });
  const refused = await policy.rejectIfMeteredBudgetExceeded("key-both", METERED, "openai/x");
  assert.equal(refused?.status, 429);
  assert.equal((await refused?.json()).error.code, "BUDGET_EXCEEDED");
  costRules.resetCostData();
  await call(itemRoute.DELETE, "DELETE", budget.id);
});

test("the streaming and non-streaming cost paths both feed the budgets", () => {
  const budget = repo.createBudget({ name: "Paths", maxUsd: 100, duration: "daily" });
  repo.replaceBudgetAssignments(budget.id, [{ scopeType: "key", scopeValue: "key-paths" }]);
  // recordChatCallCost (non-streaming) and a bare recordCost (streaming/search) share one entry.
  costRules.recordChatCallCost({ id: "key-paths" }, 0.5, { provider: METERED, model: "m" }, true);
  costRules.recordCost("key-paths", 0.25, { provider: METERED, model: "m", success: true });
  assert.equal(engine.getBudgetUsage(budget).spentUsd, 0.75);
  repo.deleteBudget(budget.id);
});

// --- soft alert through the real webhook dispatcher -------------------------------------------

test("budget.warning is a registered webhook event", () => {
  assert.ok(WEBHOOK_EVENT_VALUES.includes("budget.warning"));
  assert.ok(EVENT_DESCRIPTIONS["budget.warning"].label);
});

test("crossing the soft threshold delivers one budget.warning per window to subscribed webhooks", async () => {
  const hook = webhooks.createWebhook({
    // A private address: delivery is refused by the outbound guard, but the attempt is logged.
    url: "http://127.0.0.1:9/hook",
    events: ["budget.warning"],
    secret: "whsec_test_secret_value",
  });
  const { budget } = await (
    await post({ name: "Alerting", maxUsd: 10, softUsd: 5, keyIds: ["key-alert"] })
  ).json();

  costRules.recordCost("key-alert", 4, { provider: METERED });
  costRules.recordCost("key-alert", 2, { provider: METERED });
  costRules.recordCost("key-alert", 2, { provider: METERED });
  await new Promise((resolve) => setTimeout(resolve, 300));

  const rows = getDbInstance()
    .prepare("SELECT event_type, payload_snapshot FROM webhook_deliveries WHERE webhook_id = ?")
    .all(hook.id) as { event_type: string; payload_snapshot: string | null }[];
  assert.equal(rows.length, 1, "exactly one delivery attempt for the window");
  assert.equal(rows[0].event_type, "budget.warning");
  const payload = JSON.parse(rows[0].payload_snapshot ?? "{}");
  assert.equal(payload.event, "budget.warning");
  assert.equal(payload.data.budgetId, budget.id);
  assert.equal(payload.data.spentUsd, 6);
  assert.doesNotMatch(rows[0].payload_snapshot ?? "", /whsec_|API_KEY|sk-/);
  webhooks.deleteWebhook(hook.id);
  await call(itemRoute.DELETE, "DELETE", budget.id);
});
