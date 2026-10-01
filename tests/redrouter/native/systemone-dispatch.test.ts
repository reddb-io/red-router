import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const directory = mkdtempSync(join(tmpdir(), "redrouter-s1-dispatch-"));
process.env.DATA_DIR = directory;
const { dispatchSystemOne } = await import("../../../src/sse/services/systemOneDispatch.ts");
const { resolveSystemOneTarget } = await import("../../../open-sse/handlers/systemOneCore.ts");
const { resetDbInstance } = await import("../../../src/lib/db/core.ts");
type Dependencies = NonNullable<Parameters<typeof dispatchSystemOne>[3]>;
const body = { state: "Ready", questions: { ready: { type: "noul" } }, extension: { keep: true } };
const target = resolveSystemOneTarget("typesafe-ai/jev-latest")!;

after(() => {
  resetDbInstance();
  rmSync(directory, { recursive: true, force: true });
});

function setup(overrides: Dependencies = {}) {
  const events: string[] = [];
  const dependencies: Dependencies = {
    credentials: async () =>
      ({ connectionId: "connection", apiKey: "upstream-secret" }) as Awaited<
        ReturnType<NonNullable<Dependencies["credentials"]>>
      >,
    budget: async () => {
      events.push("budget");
      return null;
    },
    proxy: async (_id, key) => {
      events.push(`proxy:${key}`);
      return null;
    },
    blockedProxy: () => false,
    keyQuota: () => ({ allowed: true, reason: null, dimension: null }),
    tokenLimits: () => null,
    recordKeyQuota: () => {},
    recordWindowTokens: () => {},
    leased: async () => false,
    forward: async (_target, _token, forwarded) => {
      assert.deepEqual(forwarded, body);
      events.push("forward");
      return {
        response: Response.json({ answers: { ready: { noul: 0.99 } } }),
        usage: { input_tokens: 10, output_tokens: 5 },
      };
    },
    recover: async () => {
      events.push("recover");
    },
    usage: async () => {
      events.push("usage");
      return true;
    },
    cost: async () => ({ costUsd: 0.12, priced: true }),
    recordCost: (key, amount, details) => {
      assert.equal(key, "client-key");
      assert.equal(amount, 0.12);
      assert.deepEqual(details?.attribution?.tags, ["team"]);
      events.push("cost");
    },
    recordTokens: (actor, provider, tokens) => {
      assert.equal(actor?.id, "client-key");
      assert.equal(provider, target.provider);
      assert.equal(tokens, 15);
      events.push("tokens");
    },
    unavailable: async () => {
      events.push("unavailable");
      return undefined;
    },
    ...overrides,
  };
  return { dependencies, events };
}
const options = {
  apiKeyId: "client-key",
  attribution: { tags: ["team"], endUser: "user", sessionId: "session" },
};

test("an empty evaluated connection intersection denies S1 without widening access", async () => {
  const { dependencies, events } = setup();
  const result = await dispatchSystemOne(
    target,
    body,
    { ...options, allowedConnections: [] },
    dependencies
  );
  assert.equal(result.response.status, 403);
  assert.deepEqual(events, []);
});

test("S1 budget refusal prevents credential acquisition and upstream inference", async () => {
  const { dependencies, events } = setup({
    budget: async () => new Response("blocked", { status: 429 }),
    credentials: async () => {
      throw new Error("must not select a credential");
    },
  });
  const result = await dispatchSystemOne(target, body, options, dependencies);
  assert.equal(result.response.status, 429);
  assert.deepEqual(events, []);
});

test("key quotas reject internal S1 before inference and reasoning tokens count toward token limits", async () => {
  const blocked = setup({
    keyQuota: () => ({ allowed: false, reason: "quota exhausted", dimension: "tpm" }),
  });
  assert.equal(
    (await dispatchSystemOne(target, body, options, blocked.dependencies)).response.status,
    429
  );
  assert.deepEqual(blocked.events, []);
  const successful = setup({
    forward: async () => ({
      response: Response.json({ answers: {} }),
      usage: { input_tokens: 10, output_tokens: 5, reasoning_tokens: 7 },
    }),
    recordTokens: (_actor, _provider, tokens) => assert.equal(tokens, 22),
    recordKeyQuota: (_id, tokens) => assert.equal(tokens, 22),
    recordWindowTokens: (_id, _provider, _model, tokens) => assert.equal(tokens, 22),
  });
  assert.equal(
    (await dispatchSystemOne(target, body, options, successful.dependencies)).response.status,
    200
  );
});

test("S1 uses per-key proxy and records usage, cost, ledger context and TPM once", async () => {
  const { dependencies, events } = setup();
  const result = await dispatchSystemOne(target, body, options, dependencies);
  assert.equal(result.response.status, 200);
  assert.equal(result.accountingSucceeded, true);
  assert.deepEqual(events, [
    "budget",
    "proxy:client-key",
    "forward",
    "recover",
    "cost",
    "tokens",
    "usage",
  ]);
});

test("completed paid response survives accounting failure without acquiring or dispatching another credential", async () => {
  const { dependencies, events } = setup({ usage: async () => false });
  const result = await dispatchSystemOne(target, body, options, dependencies);
  assert.equal(result.response.status, 200);
  assert.equal(result.accountingSucceeded, false);
  assert.equal(events.filter((event) => event === "forward").length, 1);
  assert.equal(events.filter((event) => event === "cost").length, 1);
});

test("federated S1 derives endpoint from selected connection and rejects a nondecision catalog entry", async () => {
  const remoteTarget = resolveSystemOneTarget("red/openrouter/typesafe/jev-1.13")!;
  let catalogChecks = 0;
  const { dependencies, events } = setup({
    credentials: async (_provider, _context, _allowed, _model, selection) => {
      if (selection?.excludeConnectionIds?.length) return null;
      return {
        connectionId: "remote",
        apiKey: "remote-key",
        providerSpecificData: { baseUrl: "https://remote.example/api/v1" },
      } as Awaited<ReturnType<NonNullable<Dependencies["credentials"]>>>;
    },
    catalog: (snapshot) => {
      assert.equal(snapshot.id, "remote");
      catalogChecks++;
      return {
        fingerprint: snapshot.fingerprint,
        syncedAt: Date.now(),
        models: [{ id: remoteTarget.model, type: catalogChecks === 1 ? "chat" : "systemone" }],
      };
    },
    forward: async (resolved, token, _body, forwarding) => {
      assert.equal(resolved.url, "https://remote.example/api/v1/systemone");
      assert.equal(token, "remote-key");
      assert.equal(typeof forwarding?.fetchImpl, "function");
      events.push("forward");
      return { response: Response.json({ answers: {} }), usage: null };
    },
  });
  const first = await dispatchSystemOne(remoteTarget, body, options, dependencies);
  assert.equal(first.response.status, 503);
  assert.ok(!events.includes("forward"));
  const second = await dispatchSystemOne(remoteTarget, body, options, dependencies);
  assert.equal(second.response.status, 200);
  assert.equal(events.filter((event) => event === "forward").length, 1);
});

test("transient S1 failures cool only the selected connection before using another credential", async () => {
  let sends = 0;
  const { dependencies, events } = setup({
    credentials: async (_provider, _context, _allowed, _model, selection) =>
      ({
        connectionId: selection?.excludeConnectionIds?.length ? "second" : "first",
        apiKey: "secret",
      }) as Awaited<ReturnType<NonNullable<Dependencies["credentials"]>>>,
    forward: async () => {
      sends++;
      return { response: new Response("{}", { status: sends === 1 ? 503 : 200 }), usage: null };
    },
    unavailable: async (id, status) => {
      assert.equal(id, "first");
      assert.equal(status, 503);
      events.push("cool-first");
      return undefined;
    },
  });
  assert.equal((await dispatchSystemOne(target, body, options, dependencies)).response.status, 200);
  assert.equal(sends, 2);
  assert.equal(events.filter((event) => event === "budget").length, 1);
  assert.equal(events.filter((event) => event === "cool-first").length, 1);
});

test("Zen refusal of borrowed Go credentials leaves normal Go traffic available", async () => {
  const zen = resolveSystemOneTarget("opencode-zen/jev-latest")!;
  const { dependencies, events } = setup({
    credentials: async (provider, _context, _allowed, _model, selection) => {
      if (provider === "opencode-zen" || selection?.excludeConnectionIds?.length) return null;
      return { connectionId: "go", apiKey: "go-key" } as Awaited<
        ReturnType<NonNullable<Dependencies["credentials"]>>
      >;
    },
    forward: async () => ({ response: new Response("{}", { status: 403 }), usage: null }),
  });
  assert.equal((await dispatchSystemOne(zen, body, options, dependencies)).response.status, 403);
  assert.ok(!events.includes("unavailable"));
});

test("real S1 accounting writes one usage row and one attributed ledger row, then enforces the token budget", async () => {
  const { createApiKey } = await import("../../../src/lib/db/apiKeys.ts");
  const { getDbInstance } = await import("../../../src/lib/db/core.ts");
  const budgets = await import("../../../src/lib/db/budgets.ts");
  const engine = await import("../../../src/domain/budgetEngine.ts");
  const key = await createApiKey("System One test", "s1-test-machine", []);
  const cap = budgets.createBudget({
    name: "S1 tokens",
    maxUsd: 10,
    duration: "daily",
    onExceed: "block",
    tpmLimit: 15,
  });
  budgets.replaceBudgetAssignments(cap.id, [{ scopeType: "key", scopeValue: key.id }]);
  engine.resetBudgetEngineCache();
  const { dependencies, events } = setup();
  const transport: Dependencies = {
    credentials: dependencies.credentials,
    proxy: dependencies.proxy,
    blockedProxy: dependencies.blockedProxy,
    leased: dependencies.leased,
    forward: dependencies.forward,
    recover: dependencies.recover,
    cost: dependencies.cost,
  };
  const actor = { ...options, apiKeyId: key.id };
  const first = await dispatchSystemOne(target, body, actor, transport);
  assert.equal(first.response.status, 200);
  assert.equal(first.accountingSucceeded, true);
  // recordCost writes the ledger asynchronously; yield once for its pricing lookup.
  await new Promise((resolve) => setImmediate(resolve));
  const db = getDbInstance();
  const usage = db
    .prepare("SELECT tokens_input, tokens_output, endpoint FROM usage_history WHERE api_key_id = ?")
    .all(key.id);
  assert.deepEqual(usage, [{ tokens_input: 10, tokens_output: 5, endpoint: "/v1/systemone" }]);
  const { getKeyQuotaStatus } = await import("../../../src/lib/db/keyQuota.ts");
  const quotaStatus = getKeyQuotaStatus(key.id);
  assert.equal(quotaStatus.counters.tpmUsed, 15);
  assert.equal(quotaStatus.counters.rpmUsed, 1);
  const ledger = db
    .prepare(
      "SELECT amount_usd, end_user, tags, session_id FROM request_cost_ledger WHERE api_key_id = ?"
    )
    .all(key.id);
  assert.deepEqual(ledger, [
    { amount_usd: 0.12, end_user: "user", tags: '["team"]', session_id: "session" },
  ]);
  const second = await dispatchSystemOne(target, body, actor, transport);
  assert.equal(second.response.status, 429);
  assert.equal(events.filter((event) => event === "forward").length, 1);
});

test("a pinned evaluator uses only the chosen connection and never widens a denied scope", async () => {
  let credentialsCalled = false;
  const { dependencies, events } = setup({
    credentials: async (_provider, _excluded, allowed, _model, settings) => {
      credentialsCalled = true;
      assert.deepEqual(allowed, ["connection"]);
      assert.equal(settings?.forcedConnectionId, "connection");
      return { connectionId: "connection", apiKey: "upstream-secret" } as Awaited<
        ReturnType<NonNullable<Dependencies["credentials"]>>
      >;
    },
  });
  const denied = await dispatchSystemOne(
    target,
    body,
    { ...options, allowedConnections: ["other"], forcedConnectionId: "connection" },
    dependencies
  );
  assert.equal(denied.response.status, 403);
  assert.equal(credentialsCalled, false);
  const allowed = await dispatchSystemOne(
    target,
    body,
    { ...options, allowedConnections: ["connection"], forcedConnectionId: "connection" },
    dependencies
  );
  assert.equal(allowed.response.status, 200);
  assert.ok(events.includes("forward"));
});
