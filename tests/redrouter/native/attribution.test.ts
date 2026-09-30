import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// Attribution: parsing of the end user, tags and session id of a request, and where they land
// (cost ledger, call log, tag / end-user budgets, the usage rollup API).
const dataDir = mkdtempSync(join(tmpdir(), "redrouter-attribution-"));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = "test-jwt-secret-for-attribution";
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "attribution-test-secret";

const { getDbInstance, resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { updateSettings } = await import("../../../src/lib/db/settings.ts");
const { hashManagementPassword } = await import("../../../src/lib/auth/managementPassword.ts");
const { DASHBOARD_SESSION_COOKIE, getDashboardJwtSecret, mintDashboardSessionToken } =
  await import("../../../src/shared/utils/dashboardSessionToken.ts");
const { createApiKey } = await import("../../../src/lib/db/apiKeys.ts");
const attribution = await import("../../../src/lib/usage/attribution.ts");
const constants = await import("../../../src/shared/constants/attribution.ts");
const repo = await import("../../../src/lib/db/budgets.ts");
const engine = await import("../../../src/domain/budgetEngine.ts");
const costRules = await import("../../../src/domain/costRules.ts");
const callLogs = await import("../../../src/lib/usage/callLogs.ts");
const rollupRoute = await import("../../../src/app/api/usage/attribution/route.ts");
const budgetsRoute = await import("../../../src/app/api/budgets/route.ts");
const assignRoute = await import("../../../src/app/api/budgets/[id]/assignments/route.ts");
const { recordLedgerEntry } = await import("../../../src/lib/db/costLedger.ts");

after(() => {
  engine.setBudgetWarningNotifier(null);
  resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

const { resolveAttribution } = attribution;

function request(headers: Record<string, string> = {}) {
  return new Request("http://localhost/v1/chat/completions", { method: "POST", headers });
}

// --- parsing ----------------------------------------------------------------------------------

test("the end user comes from the body user field, else the header, trimmed and bounded", () => {
  const cases: Array<{
    name: string;
    headers: Record<string, string>;
    body: unknown;
    expected: string | null;
  }> = [
    { name: "body user", headers: {}, body: { user: "alice" }, expected: "alice" },
    { name: "header only", headers: { "x-red-router-end-user": "bob" }, body: {}, expected: "bob" },
    {
      name: "body wins over header",
      headers: { "x-red-router-end-user": "bob" },
      body: { user: "alice" },
      expected: "alice",
    },
    { name: "trimmed", headers: {}, body: { user: "  carol  " }, expected: "carol" },
    {
      name: "control characters stripped",
      headers: {},
      body: { user: "dave\u0000\u0007\n x\u007f" },
      expected: "davex",
    },
    {
      name: "blank falls through to the header",
      headers: { "x-red-router-end-user": "eve" },
      body: { user: "   " },
      expected: "eve",
    },
    { name: "non-string ignored", headers: {}, body: { user: 42 }, expected: null },
    { name: "object ignored", headers: {}, body: { user: { id: "x" } }, expected: null },
    { name: "absent", headers: {}, body: {}, expected: null },
    { name: "no body", headers: {}, body: null, expected: null },
    { name: "array body", headers: {}, body: [], expected: null },
    {
      name: "128 characters kept",
      headers: {},
      body: { user: "u".repeat(128) },
      expected: "u".repeat(128),
    },
    {
      name: "129th character cut",
      headers: {},
      body: { user: "u".repeat(200) },
      expected: "u".repeat(128),
    },
    { name: "unicode kept", headers: {}, body: { user: "zoë-用户" }, expected: "zoë-用户" },
    {
      name: "html kept as data",
      headers: {},
      body: { user: "<script>alert(1)</script>" },
      expected: "<script>alert(1)</script>",
    },
  ];
  for (const testCase of cases) {
    assert.equal(
      resolveAttribution(request(testCase.headers), testCase.body, null, []).endUser,
      testCase.expected,
      testCase.name
    );
  }
});

test("tags merge the key's tags, metadata.tags and the header: lowercased, deduped, bounded", () => {
  const tagsOf = (headers: Record<string, string>, body: unknown, keyTags: string[] = []) =>
    resolveAttribution(request(headers), body, { id: "k" }, keyTags).tags;

  assert.deepEqual(tagsOf({}, {}), []);
  assert.deepEqual(tagsOf({}, { metadata: { tags: ["Team-A", "prod"] } }), ["team-a", "prod"]);
  assert.deepEqual(tagsOf({ "x-red-router-tags": "Web, MOBILE ,,web" }, {}), ["web", "mobile"]);
  // The key's tags come first, then the body's, then the header's; duplicates keep the first.
  assert.deepEqual(
    tagsOf({ "x-red-router-tags": "c, a" }, { metadata: { tags: ["B", "a"] } }, ["A", "key-tag"]),
    ["a", "key-tag", "b", "c"]
  );
  // Only strings from an array are read.
  assert.deepEqual(tagsOf({}, { metadata: { tags: "nope" } }), []);
  assert.deepEqual(tagsOf({}, { metadata: { tags: ["ok", 7, null, { a: 1 }, ["x"]] } }), ["ok"]);
  assert.deepEqual(tagsOf({}, { metadata: "nope" }), []);
  // Each tag is cut to 32 characters, control characters are stripped, blanks dropped.
  assert.deepEqual(tagsOf({}, { metadata: { tags: ["x".repeat(40), "a\u0000b", "   "] } }), [
    "x".repeat(32),
    "ab",
  ]);
  // At most 20, and the key's own tags survive a client flooding the request.
  const flood = Array.from({ length: 50 }, (_, i) => `t${i}`);
  const capped = tagsOf({}, { metadata: { tags: flood } }, ["operator"]);
  assert.equal(capped.length, constants.TAGS_MAX_COUNT);
  assert.equal(capped[0], "operator");
  assert.equal(capped.at(-1), "t18");
});

test("the session id is the existing x-omniroute-session-id header", () => {
  assert.equal(
    resolveAttribution(request({ "x-omniroute-session-id": " sess-1 " }), {}, null, []).sessionId,
    "sess-1"
  );
  assert.equal(resolveAttribution(request(), {}, null, []).sessionId, null);
  assert.equal(
    resolveAttribution(request({ "x-session-id": "other" }), {}, null, []).sessionId,
    null,
    "no other header is read"
  );
});

test("the key's stored tags are read from the database when not supplied", async () => {
  attribution.resetAttributionCache();
  const key = await createApiKey("tagged", "attr-machine", [], { tags: ["Finance", "internal"] });
  const resolved = resolveAttribution(request(), { metadata: { tags: ["extra"] } }, { id: key.id });
  assert.deepEqual(resolved.tags, ["finance", "internal", "extra"]);
  // No key, unknown key and a failing lookup all leave the request's own tags.
  assert.deepEqual(resolveAttribution(request(), {}, null).tags, []);
  assert.deepEqual(resolveAttribution(request(), {}, { id: "missing" }).tags, []);
});

test("withRequestAttribution copies the key record and never mutates the cached one", () => {
  const cached = { id: "key-1", name: "n" };
  const signal = new AbortController().signal;
  const wrapped = attribution.withRequestAttribution(
    cached,
    request({ "x-red-router-end-user": "zed" }),
    {},
    signal
  );
  assert.notEqual(wrapped, cached);
  assert.equal("attribution" in cached, false);
  assert.equal(wrapped.attribution.endUser, "zed");
  assert.equal(wrapped.id, "key-1");
  assert.deepEqual(attribution.getRequestBudgetScope(signal)?.keyId, "key-1");
  assert.equal(attribution.getRequestBudgetScope(new AbortController().signal), null);
  assert.equal(attribution.getRequestBudgetScope(null), null);
  // A request without a key is returned as it came.
  assert.equal(attribution.withRequestAttribution(null, request(), {}, signal), null);
  assert.equal(attribution.withRequestAttribution(undefined, request(), {}, signal), undefined);
});

// --- persistence ------------------------------------------------------------------------------

async function waitFor<T>(read: () => T | undefined, what: string): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test("recordCost stamps end user, tags and session id on the ledger row (and no prompt text)", async () => {
  costRules.recordCost("key-ledger", 0.25, {
    provider: "openai",
    model: "gpt-4o",
    tokens: { prompt_tokens: 10, completion_tokens: 5 },
    requestId: "req-ledger",
    attribution: { endUser: "alice", tags: ["team-a", "prod"], sessionId: "sess-9" },
  });
  const row = await waitFor(
    () =>
      getDbInstance()
        .prepare("SELECT * FROM request_cost_ledger WHERE request_id = 'req-ledger'")
        .get() as Record<string, unknown> | undefined,
    "the ledger row"
  );
  assert.equal(row.end_user, "alice");
  assert.equal(row.tags, JSON.stringify(["team-a", "prod"]));
  assert.equal(row.session_id, "sess-9");
  assert.equal(row.amount_usd, 0.25);
  assert.deepEqual(
    Object.keys(row).filter((column) => /prompt|content|message|body/i.test(column)),
    [],
    "the ledger has no column that could hold prompt text"
  );

  // A row without attribution keeps the columns NULL.
  costRules.recordCost("key-ledger", 0.1, {
    provider: "openai",
    model: "gpt-4o",
    requestId: "req-plain",
  });
  const plain = await waitFor(
    () =>
      getDbInstance()
        .prepare(
          "SELECT end_user, tags, session_id FROM request_cost_ledger WHERE request_id = 'req-plain'"
        )
        .get() as Record<string, unknown> | undefined,
    "the plain ledger row"
  );
  assert.deepEqual({ ...plain }, { end_user: null, tags: null, session_id: null });
});

test("recordChatCallCost reads the attribution from the request's key record", async () => {
  const signal = new AbortController().signal;
  const info = attribution.withRequestAttribution(
    { id: "key-chat" },
    request({ "x-red-router-tags": "Batch", "x-omniroute-session-id": "s-chat" }),
    { user: "frank" },
    signal
  );
  costRules.recordChatCallCost(
    info,
    0.5,
    costRules.buildCostCtx(
      "openai",
      "gpt-4o",
      { prompt_tokens: 1, completion_tokens: 1 },
      "standard",
      "req-chat"
    ),
    true
  );
  const row = await waitFor(
    () =>
      getDbInstance()
        .prepare(
          "SELECT end_user, tags, session_id FROM request_cost_ledger WHERE request_id = 'req-chat'"
        )
        .get() as Record<string, unknown> | undefined,
    "the chat ledger row"
  );
  assert.deepEqual(
    { ...row },
    { end_user: "frank", tags: JSON.stringify(["batch"]), session_id: "s-chat" }
  );
});

test("the call log stores end user and tags, bounded, and NULL when absent", async () => {
  await callLogs.saveCallLog({
    id: "attr-log-1",
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "m",
    provider: "p",
    duration: 1,
    tokens: { in: 1, out: 1 },
    endUser: "  grace\u0007  ",
    tags: ["Team-A", "team-a", "y".repeat(50)],
  });
  await callLogs.saveCallLog({
    id: "attr-log-2",
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    model: "m",
    provider: "p",
    duration: 1,
    tokens: { in: 1, out: 1 },
  });
  const db = getDbInstance();
  const first = db
    .prepare("SELECT end_user, tags FROM call_logs WHERE id = 'attr-log-1'")
    .get() as Record<string, unknown>;
  assert.equal(first.end_user, "grace");
  assert.equal(first.tags, JSON.stringify(["team-a", "y".repeat(32)]));
  const second = db
    .prepare("SELECT end_user, tags FROM call_logs WHERE id = 'attr-log-2'")
    .get() as Record<string, unknown>;
  assert.deepEqual({ ...second }, { end_user: null, tags: null });
});

// --- tag / end-user budgets through the recording path -----------------------------------------

test("cost recorded with attribution accrues to a tag budget and blocks the tagged request", () => {
  const budget = repo.createBudget({ name: "Tag cap", maxUsd: 1, duration: "daily" });
  repo.replaceBudgetAssignments(budget.id, [
    { scopeType: "tag", scopeValue: "finance" },
    { scopeType: "user", scopeValue: "heidi" },
  ]);
  costRules.recordCost("key-scope", 0.6, {
    provider: "openai",
    model: "gpt-4o",
    attribution: { tags: ["finance"], endUser: null },
  });
  costRules.recordCost("key-scope", 0.6, {
    provider: "openai",
    model: "gpt-4o",
    attribution: { tags: [], endUser: "heidi" },
  });
  const window = engine.computeBudgetWindow(budget).windowStart;
  assert.equal(repo.getWindowSpent(budget.id, "tag:finance", window), 0.6);
  assert.equal(repo.getWindowSpent(budget.id, "user:heidi", window), 0.6);
  costRules.recordCost("key-scope", 0.6, {
    provider: "openai",
    model: "gpt-4o",
    attribution: { tags: ["finance"], endUser: "heidi" },
  });
  assert.equal(
    engine.checkBudgets({ keyId: "key-scope", provider: "openai", tags: ["finance"] }).state,
    "blocked"
  );
  assert.equal(
    engine.checkBudgets({ keyId: "key-scope", provider: "openai", endUser: "heidi" }).state,
    "blocked"
  );
  assert.equal(engine.checkBudgets({ keyId: "key-scope", provider: "openai" }).state, "ok");
});

// --- API: assignments and the rollup ----------------------------------------------------------

async function sessionCookie() {
  const token = await mintDashboardSessionToken(getDashboardJwtSecret());
  return `${DASHBOARD_SESSION_COOKIE}=${token}`;
}

const rollup = async (query: string, authenticated = true) =>
  rollupRoute.GET(
    new Request(`http://localhost/api/usage/attribution${query}`, {
      headers: authenticated ? { cookie: await sessionCookie() } : {},
    })
  );

test("the budgets API accepts tag and end-user assignments, normalises them and validates them", async () => {
  await updateSettings({
    requireLogin: true,
    password: await hashManagementPassword("correct horse battery staple 42"),
  });
  const post = async (body: unknown) =>
    budgetsRoute.POST(
      new Request("http://localhost/api/budgets", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: await sessionCookie() },
        body: JSON.stringify(body),
      })
    );
  const created = await post({
    name: "Scoped",
    maxUsd: 10,
    tpmLimit: 1000,
    rpmLimit: 20,
    modelMax: { "openai/gpt-4o": 2, "anthropic/*": 3 },
    tags: ["  Team-A ", "team-a", "ops"],
    users: ["alice", " bob "],
  });
  assert.equal(created.status, 201);
  const { budget } = await created.json();
  assert.equal(budget.tpmLimit, 1000);
  assert.equal(budget.rpmLimit, 20);
  assert.deepEqual(budget.modelMax, { "openai/gpt-4o": 2, "anthropic/*": 3 });
  assert.deepEqual(budget.tags, ["ops", "team-a"]);
  assert.deepEqual(budget.users, ["alice", "bob"]);

  const invalid: unknown[] = [
    { name: "x", maxUsd: 5, tpmLimit: 0 },
    { name: "x", maxUsd: 5, tpmLimit: 1.5 },
    { name: "x", maxUsd: 5, rpmLimit: -3 },
    { name: "x", maxUsd: 5, modelMax: { "bad key": 1 } },
    { name: "x", maxUsd: 5, modelMax: { "openai/gpt-4o": 0 } },
    { name: "x", maxUsd: 5, modelMax: { "*": 1 } },
    { name: "x", maxUsd: 5, tags: ["y".repeat(33)] },
    { name: "x", maxUsd: 5, tags: ["   "] },
    { name: "x", maxUsd: 5, users: ["u".repeat(129)] },
    { name: "x", maxUsd: 5, users: [""] },
    { name: "x", maxUsd: 5, tags: "nope" },
  ];
  for (const body of invalid) {
    assert.equal((await post(body)).status, 400, JSON.stringify(body));
  }

  // The assignment endpoint keeps tags and users a slice-1 client does not know about.
  const put = async (body: unknown) =>
    assignRoute.PUT(
      new Request(`http://localhost/api/budgets/${budget.id}/assignments`, {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: await sessionCookie() },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: budget.id }) }
    );
  const keysOnly = await (await put({ keyIds: ["k1"], groupIds: [] })).json();
  assert.deepEqual(keysOnly, {
    keyIds: ["k1"],
    groupIds: [],
    tags: ["ops", "team-a"],
    users: ["alice", "bob"],
  });
  const cleared = await (
    await put({ keyIds: [], groupIds: [], tags: [], users: ["carol"] })
  ).json();
  assert.deepEqual(cleared, { keyIds: [], groupIds: [], tags: [], users: ["carol"] });
});

test("GET /api/usage/attribution requires management auth and validates its query", async () => {
  await updateSettings({
    requireLogin: true,
    password: await hashManagementPassword("correct horse battery staple 42"),
  });
  assert.equal((await rollup("?by=tag", false)).status, 401);
  assert.equal((await rollup("?by=tag")).status, 200);
  for (const query of [
    "",
    "?by=key",
    "?by=tag&days=0",
    "?by=tag&days=366",
    "?by=tag&days=x",
    "?days=30",
  ]) {
    assert.equal((await rollup(query)).status, 400, query);
  }
});

test("the rollup totals spend and requests per tag and per end user over the window", async () => {
  const db = getDbInstance();
  db.prepare("DELETE FROM request_cost_ledger").run();
  const day = 86_400_000;
  const at = (daysAgo: number) => new Date(Date.now() - daysAgo * day).toISOString();
  const entry = (
    amountUsd: number,
    daysAgo: number,
    extra: { endUser?: string | null; tags?: string | null } = {}
  ) =>
    recordLedgerEntry({
      apiKeyId: "key-rollup",
      provider: "openai",
      model: "gpt-4o",
      amountUsd,
      timestamp: at(daysAgo),
      endUser: extra.endUser ?? null,
      tags: extra.tags ?? null,
    });
  entry(1, 1, { endUser: "alice", tags: JSON.stringify(["team-a", "prod"]) });
  entry(2, 2, { endUser: "alice", tags: JSON.stringify(["team-a"]) });
  entry(4, 3, { endUser: "bob", tags: JSON.stringify(["prod"]) });
  entry(8, 40, { endUser: "alice", tags: JSON.stringify(["team-a"]) }); // outside 30 days
  entry(16, 1); // unattributed: in no rollup
  entry(32, 1, { tags: "not json" }); // a hand-edited row must not break the rollup

  const byTag = await (await rollup("?by=tag&days=30")).json();
  assert.equal(byTag.by, "tag");
  assert.equal(byTag.days, 30);
  assert.deepEqual(byTag.rows, [
    { key: "prod", amountUsd: 5, requestCount: 2 },
    { key: "team-a", amountUsd: 3, requestCount: 2 },
  ]);

  const byUser = await (await rollup("?by=user&days=30")).json();
  assert.deepEqual(byUser.rows, [
    { key: "bob", amountUsd: 4, requestCount: 1 },
    { key: "alice", amountUsd: 3, requestCount: 2 },
  ]);

  const wide = await (await rollup("?by=user&days=90")).json();
  assert.deepEqual(wide.rows[0], { key: "alice", amountUsd: 11, requestCount: 3 });

  // Default window is 30 days; the response never carries anything but the rollup fields.
  const defaulted = await (await rollup("?by=tag")).json();
  assert.equal(defaulted.days, 30);
  assert.deepEqual(Object.keys(defaulted.rows[0]).sort(), ["amountUsd", "key", "requestCount"]);
  assert.doesNotMatch(JSON.stringify(defaulted), /prompt|message|content/i);
});

test("the rollup returns at most 100 rows, largest spend first", async () => {
  const db = getDbInstance();
  db.prepare("DELETE FROM request_cost_ledger").run();
  const insert = db.prepare(
    "INSERT INTO request_cost_ledger (api_key_id, provider, model, amount_usd, timestamp, end_user) VALUES ('k', 'p', 'm', ?, ?, ?)"
  );
  const now = new Date().toISOString();
  for (let i = 0; i < 130; i++) insert.run(i + 1, now, `user-${i}`);
  const rows = (await (await rollup("?by=user&days=7")).json()).rows;
  assert.equal(rows.length, 100);
  assert.equal(rows[0].key, "user-129");
  assert.equal(rows[0].amountUsd, 130);
});

test("attribution never becomes a metrics label", () => {
  for (const file of ["collect.ts", "prometheusText.ts"]) {
    const source = readFileSync(
      new URL(`../../../src/lib/metrics/${file}`, import.meta.url),
      "utf8"
    );
    assert.doesNotMatch(source, /end_?user|endUser|attribution/i, file);
  }
});
