import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "redrouter-federation-"));
process.env.DATA_DIR = dir;
process.env.REQUIRE_API_KEY = "false";
process.env.INITIAL_PASSWORD = "";
process.env.API_KEY_SECRET ||= "federation-test-secret";
process.env.OMNIROUTE_ALLOW_LOCAL_PROVIDER_URLS = "true";
const { resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { createProviderConnection } = await import("../../../src/lib/db/providers.ts");
const { updateSettings } = await import("../../../src/lib/db/settings.ts");
const { commitRemoteRouterCatalog, readRemoteRouterCatalog } =
  await import("../../../src/lib/db/remoteRouterCatalog.ts");
const { remoteRouterSnapshot, parseRemoteRouterModels, createRemoteRouterCatalogSync } =
  await import("../../../src/lib/providerModels/remoteRouterCatalog.ts");
const { getUnifiedModelsResponse } = await import("../../../src/app/api/v1/models/catalog.ts");
const { handleChat } = await import("../../../src/sse/handlers/chat.ts");
const { initTranslators } = await import("../../../open-sse/translator/index.ts");
const { handleSystemOne } = await import("../../../src/sse/handlers/systemOne.ts");
const { forwardSystemOne, resolveSystemOneTarget } =
  await import("../../../open-sse/handlers/systemOneCore.ts");
const { createTenant, assignResourcesToTenant, assignApiKeysToTenant } =
  await import("../../../src/lib/db/tenants.ts");
const { setTenantRoutingSide } = await import("../../../src/lib/db/routingPolicy.ts");
const { createApiKey } = await import("../../../src/lib/db/apiKeys.ts");
const { isReservedProviderPrefix } =
  await import("../../../src/shared/constants/reservedProviderPrefixes.ts");
const { parseModel } = await import("../../../open-sse/services/model.ts");
const { resetPriorityRoutingForTests } =
  await import("../../../src/sse/handlers/priorityRouting.ts");
const { collapseCatalogToBare, orderedTargetsFor } =
  await import("../../../src/lib/routing/bareModels.ts");

const decisionId = "openrouter/typesafe/jev-1.13";
const downstreamId = `red/${decisionId}`;
const publicId = `red/${downstreamId}`;
const requests: Array<{
  path: string;
  model: string;
  authorization?: string;
  body: Record<string, unknown>;
}> = [];
let remote: Server;
let final: Server;
let remoteUrl: string;
let finalUrl: string;
let connection: Awaited<ReturnType<typeof createProviderConnection>>;
let unrelated: Awaited<ReturnType<typeof createProviderConnection>>;
let fail = false;

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  return `http://127.0.0.1:${addr.port}/v1`;
}

before(async () => {
  initTranslators();
  await updateSettings({
    transparentModels: true,
    providerPriority: [],
    hideNoThinkVariants: true,
  });
  final = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    requests.push({
      path: `final${req.url}`,
      model: String(body.model),
      authorization: req.headers.authorization,
      body,
    });
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        req.url?.endsWith("/chat/completions")
          ? {
              id: "chatcmpl-federation",
              object: "chat.completion",
              created: 1,
              model: body.model,
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "ready" },
                  finish_reason: "stop",
                },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }
          : { model: body.model, answers: { ready: { noul: 0.99 } } }
      )
    );
  });
  finalUrl = await listen(final);
  remote = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET") {
      res.end(
        JSON.stringify({
          data: [
            {
              id: downstreamId,
              type: "systemone",
              supported_endpoints: ["systemone", "decisions"],
              capabilities: { decision: true, chat: false },
            },
            {
              id: "red/openrouter/vendor/s2",
              type: "chat",
              capabilities: {
                reasoning: true,
                tool_calling: true,
                vision: true,
                structured_output: true,
              },
            },
          ],
        })
      );
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    requests.push({
      path: `remote${req.url}`,
      model: String(body.model),
      authorization: req.headers.authorization,
      body,
    });
    if (fail) {
      res.statusCode = 503;
      res.end(
        JSON.stringify({ error: { message: "private upstream detail at /secret/server.ts" } })
      );
      return;
    }
    if (req.url?.endsWith("/chat/completions")) {
      const forwarded = await fetch(`${finalUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer remote-next-key" },
        body: JSON.stringify({ ...body, model: String(body.model).slice("red/".length) }),
      });
      res.statusCode = forwarded.status;
      res.end(await forwarded.text());
      return;
    }
    const target = resolveSystemOneTarget(String(body.model));
    assert.ok(target);
    const forwarded = await forwardSystemOne(
      { ...target, url: `${finalUrl}/systemone` },
      "remote-next-key",
      { ...body, state: body.state, questions: body.questions as Record<string, unknown> }
    );
    res.statusCode = forwarded.response.status;
    res.end(await forwarded.response.text());
  });
  remoteUrl = await listen(remote);
  connection = await createProviderConnection({
    provider: "red-router",
    authType: "apikey",
    apiKey: "local-next-key",
    name: "Remote",
    isActive: true,
    testStatus: "active",
    providerSpecificData: { baseUrl: remoteUrl },
  });
  unrelated = await createProviderConnection({
    provider: "red-router",
    authType: "apikey",
    apiKey: "unrelated-key",
    name: "Other",
    isActive: true,
    testStatus: "active",
    providerSpecificData: { baseUrl: finalUrl },
  });
  const sync = createRemoteRouterCatalogSync({
    read: readRemoteRouterCatalog,
    commit: commitRemoteRouterCatalog,
    fetch: (url, init) => fetch(url, init),
  });
  assert.equal((await sync(connection)).source, "api");
  const other = remoteRouterSnapshot(unrelated);
  assert.equal(
    commitRemoteRouterCatalog(other, {
      fingerprint: other.fingerprint,
      syncedAt: Date.now(),
      models: [{ id: "different", type: "systemone" }],
    }),
    true
  );
});

after(async () => {
  await Promise.all(
    [remote, final].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
  resetDbInstance();
  rmSync(dir, { recursive: true, force: true });
});

function decision(model: string, connectionId = String(connection.id)) {
  return handleSystemOne(
    new Request("http://localhost/v1/systemone", {
      method: "POST",
      headers: { "content-type": "application/json", "x-connection-id": connectionId },
      body: JSON.stringify({
        model,
        state: "Ready",
        questions: { ready: { type: "noul", instructions: "Is it ready?" } },
        extension: { keep: true },
      }),
    })
  );
}

async function catalog(capabilities: string) {
  const response = await getUnifiedModelsResponse(
    new Request(`http://localhost/v1/models?capabilities=${capabilities}`)
  );
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()).data as Array<Record<string, unknown>>;
}

test("discovery persists both protocols and adds one public red hop per router", async () => {
  resetDbInstance();
  const saved = readRemoteRouterCatalog(remoteRouterSnapshot(connection));
  assert.equal(saved?.models[0].id, downstreamId);
  const s1 = await catalog("decision");
  const model = s1.find((m) => m.id === publicId);
  assert.ok(model, JSON.stringify(s1));
  assert.equal(model.type, "systemone");
  assert.deepEqual(model.supported_endpoints, ["systemone", "decisions"]);
  assert.equal((model.capabilities as Record<string, unknown>).chat, false);
  assert.ok(!s1.some((m) => String(m.id).startsWith("red-router/")));
  const s2 = await catalog("chat,reasoning,tools,vision,structured-output");
  assert.ok(s2.some((m) => m.id === "red/red/openrouter/vendor/s2"));
  assert.ok(!s2.some((m) => m.id === publicId));
  assert.ok(!("remoteCapabilities" in model));
});

test("native decision forwarding strips exactly one hop and uses each connection's credential", async () => {
  requests.length = 0;
  const response = await decision(publicId);
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual((await response.json()).answers, { ready: { noul: 0.99 } });
  assert.deepEqual(
    requests.map((r) => r.model),
    [downstreamId, decisionId]
  );
  assert.deepEqual(
    requests.map((r) => r.path),
    ["remote/v1/systemone", "final/v1/systemone"]
  );
  assert.deepEqual(
    requests.map((r) => r.authorization),
    ["Bearer local-next-key", "Bearer remote-next-key"]
  );
  assert.deepEqual(requests[1].body.extension, { keep: true });
  assert.deepEqual(requests[1].body.questions, {
    ready: { type: "noul", instructions: "Is it ready?" },
  });
});

test("chat forwarding preserves the chain and rejects decision IDs on chat endpoints", async () => {
  requests.length = 0;
  const call = (model: string) =>
    handleChat(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", "x-connection-id": String(connection.id) },
        body: JSON.stringify({
          model,
          stream: false,
          messages: [{ role: "user", content: "ready?" }],
        }),
      })
    );
  const rejected = await call(publicId);
  assert.equal(rejected.status, 400, await rejected.clone().text());
  assert.equal(requests.length, 0);
  const response = await call("red/red/openrouter/vendor/s2");
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(
    requests.map((r) => r.model),
    ["red/openrouter/vendor/s2", "openrouter/vendor/s2"]
  );
});

test("legacy prefixes resolve to the same internal provider without renaming downstream IDs", async () => {
  for (const prefix of ["red", "red-router", "redrouter"]) {
    assert.equal(isReservedProviderPrefix(prefix), true);
    assert.equal(parseModel(`${prefix}/${downstreamId}`).provider, "red-router");
    const response = await decision(`${prefix}/${downstreamId}`);
    assert.equal(response.status, 200, await response.clone().text());
  }
});

test("a selected connection cannot use another credential's decision catalog", async () => {
  requests.length = 0;
  const response = await decision(publicId, String(unrelated.id));
  assert.equal(response.status, 503);
  assert.equal(requests.length, 0);
});

test("opaque model names retain role and route S1 by provider priority", async () => {
  await updateSettings({ transparentModels: false, providerPriority: ["red-router"] });
  resetPriorityRoutingForTests();
  try {
    const models = await catalog("decision");
    assert.ok(models.some((m) => m.id === "jev-1.13"));
    assert.ok(models.every((m) => !String(m.id).includes("/")));
    const response = await decision("jev-1.13");
    assert.equal(response.status, 200, await response.clone().text());
    const s2 = await catalog("chat");
    assert.ok(s2.some((m) => m.id === "s2"));
  } finally {
    await updateSettings({ transparentModels: true });
    resetPriorityRoutingForTests();
  }
});

test("provider order separates chat from decisions when both share a bare name", () => {
  const models = [
    { id: "red/red/openrouter/typesafe/jev-1.13", owned_by: "red-router", type: "systemone" },
    { id: "openrouter/typesafe/jev-1.13", owned_by: "openrouter", type: "systemone" },
    { id: "other/jev-1.13", owned_by: "other", type: "chat" },
  ];
  assert.equal(
    orderedTargetsFor(models, "jev-1.13", ["openrouter", "red-router"], undefined, "decision")[0]
      .id,
    decisionId
  );
  assert.equal(
    orderedTargetsFor(models, "jev-1.13", ["red-router", "openrouter"], undefined, "decision")[0]
      .id,
    publicId
  );
  assert.equal(collapseCatalogToBare(models, ["red-router"]).length, 2);
});

test("API-key connection scope is enforced before forwarding", async () => {
  const key = await createApiKey("Scoped", "federation-machine", [], {
    allowedConnections: [String(unrelated.id)],
  });
  requests.length = 0;
  const response = await handleSystemOne(
    new Request("http://localhost/v1/decisions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key.key}`,
        "x-connection-id": String(connection.id),
      },
      body: JSON.stringify({ model: publicId, state: "Ready", questions: {} }),
    })
  );
  assert.equal(response.status, 403);
  assert.equal(requests.length, 0);
});

test("tenant owner pins hide decision routes for restricted keys without widening access", async () => {
  const tenant = createTenant({ slug: "federation-tenant" });
  const scoped = await createProviderConnection({
    provider: "red-router",
    authType: "apikey",
    apiKey: "local-next-key",
    name: "Tenant remote",
    isActive: true,
    testStatus: "active",
    providerSpecificData: { baseUrl: remoteUrl },
  });
  assignResourcesToTenant(tenant.id, { connectionIds: [String(scoped.id)] });
  const snapshot = remoteRouterSnapshot(scoped);
  const saved = readRemoteRouterCatalog(remoteRouterSnapshot(connection));
  assert.ok(saved);
  commitRemoteRouterCatalog(snapshot, { ...saved, fingerprint: snapshot.fingerprint });
  const key = await createApiKey("Tenant S1 only", "tenant-machine", [], {
    modelAccessMode: "restricted",
    allowedModels: [publicId],
  });
  assignApiKeysToTenant(tenant.id, [key.id]);
  setTenantRoutingSide(tenant.id, "owner", { transparent: false, priority: ["red-router"] });
  const models = await getUnifiedModelsResponse(
    new Request("http://localhost/v1/models?capabilities=decision", {
      headers: { authorization: `Bearer ${key.key}` },
    })
  );
  assert.deepEqual(
    (await models.json()).data.map((m: { id: string }) => m.id),
    ["jev-1.13"]
  );
  const response = await handleSystemOne(
    new Request("http://localhost/v1/systemone", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key.key}` },
      body: JSON.stringify({ model: "jev-1.13", state: "Ready", questions: {} }),
    })
  );
  assert.equal(response.status, 200, await response.clone().text());
  const denied = await handleSystemOne(
    new Request("http://localhost/v1/systemone", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key.key}` },
      body: JSON.stringify({ model: "different", state: "Ready", questions: {} }),
    })
  );
  assert.equal(denied.status, 400);
});

test("remote failures are sanitized and catalog recursion is bounded", async () => {
  fail = true;
  try {
    const response = await decision(publicId);
    assert.equal(response.status, 503);
    assert.ok(!(await response.text()).includes("/secret"));
  } finally {
    fail = false;
  }
  assert.deepEqual(
    parseRemoteRouterModels({
      data: [{ id: `${"red/".repeat(8)}${decisionId}`, type: "systemone" }],
    }),
    []
  );
});
