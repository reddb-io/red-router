import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

// Non-transparent model visibility on the request path: a bare (or still-prefixed) model name is sent
// to the providers in the owner's priority order, falling through on failure. Real handler, real
// database, a fake network.
const dataDir = mkdtempSync(join(tmpdir(), "redrouter-routing-chat-"));
process.env.DATA_DIR = dataDir;
process.env.REQUIRE_API_KEY = "false";
process.env.INITIAL_PASSWORD = "";
delete process.env.JWT_SECRET;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "routing-chat-test-secret";

const { getDbInstance, resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { updateSettings } = await import("../../../src/lib/db/settings.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");
const tenants = await import("../../../src/lib/db/tenants.ts");
const rows = await import("../../../src/lib/db/routingPolicy.ts");
const { createApiKey, clearApiKeyCaches } = await import("../../../src/lib/db/apiKeys.ts");
const { invalidateDbCache } = await import("../../../src/lib/db/readCache.ts");
const { handleChat } = await import("../../../src/sse/handlers/chat.ts");
const { resetPriorityRoutingForTests } =
  await import("../../../src/sse/handlers/priorityRouting.ts");
const { initTranslators } = await import("../../../open-sse/translator/index.ts");
const { clearInflight } = await import("../../../open-sse/services/requestDedup.ts");
const { resetAllCircuitBreakers } = await import("../../../src/shared/utils/circuitBreaker.ts");

const realFetch = globalThis.fetch;

after(() => {
  globalThis.fetch = realFetch;
  resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

let hosts: string[];
let failing: Set<string>;

function fakeNetwork() {
  hosts = [];
  globalThis.fetch = (async (url: unknown) => {
    const host = new URL(String(url)).hostname;
    hosts.push(host);
    if (failing.has(host)) {
      return new Response(
        JSON.stringify({ error: { message: "upstream boom", type: "server_error" } }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }
      );
    }
    return new Response(
      JSON.stringify({
        id: "chatcmpl-routing",
        object: "chat.completion",
        created: 1,
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: `from ${host}` },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;
}

async function connect(provider: string, tenantId?: string) {
  const conn = (await providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    name: `${provider}${tenantId ?? ""}`,
    apiKey: `sk-${provider}`,
    isActive: true,
    testStatus: "active",
  })) as { id: string };
  if (tenantId) tenants.assignResourcesToTenant(tenantId, { connectionIds: [conn.id] });
  return conn;
}

let nonce = 0;
function chat(model: string, key?: string) {
  nonce += 1;
  return handleChat(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: `ping ${nonce} ${Math.random()}` }],
        max_tokens: 8,
        stream: false,
      }),
    })
  );
}

beforeEach(async () => {
  clearInflight();
  resetAllCircuitBreakers();
  initTranslators();
  resetPriorityRoutingForTests();
  const db = getDbInstance();
  for (const table of ["tenant_routing_policy", "api_keys", "provider_connections", "combos"]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  db.prepare("DELETE FROM tenants WHERE is_default = 0").run();
  await updateSettings({
    transparentModels: false,
    providerPriority: ["aimlapi", "openai"],
    delegateRoutingToTenants: false,
  });
  invalidateDbCache();
  clearApiKeyCaches();
  failing = new Set();
  fakeNetwork();
  await connect("openai");
  await connect("aimlapi");
});

test("a bare model goes to the provider that ranks first", async () => {
  const res = await chat("gpt-4o");
  assert.equal(res.status, 200);
  assert.ok(hosts[0].includes("aimlapi"), `first hop was ${hosts[0]}`);
});

test("changing the order changes where it goes", async () => {
  await updateSettings({ providerPriority: ["openai", "aimlapi"] });
  resetPriorityRoutingForTests();
  const res = await chat("gpt-4o");
  assert.equal(res.status, 200);
  assert.ok(hosts[0].includes("openai"), `first hop was ${hosts[0]}`);
});

test("a provider prefix on the request is ignored: the priority still decides", async () => {
  const res = await chat("openai/gpt-4o");
  assert.equal(res.status, 200);
  assert.ok(hosts[0].includes("aimlapi"), "asking for openai/ did not pin the provider");
});

test("when the first provider fails the next one serves the request", async () => {
  failing.add("api.aimlapi.com");
  const res = await chat("gpt-4o");
  assert.equal(res.status, 200, await res.clone().text());
  assert.ok(
    hosts.some((h) => h.includes("aimlapi")),
    "aimlapi was tried first"
  );
  assert.ok(hosts.at(-1)!.includes("openai"), `then openai served it: ${hosts}`);
  assert.match(await res.text(), /from api\.openai\.com/);
});

test("transparent (the default) leaves the client in charge of the provider", async () => {
  await updateSettings({ transparentModels: true });
  resetPriorityRoutingForTests();
  const res = await chat("openai/gpt-4o");
  assert.equal(res.status, 200);
  assert.ok(
    hosts.every((h) => h.includes("openai")),
    `only openai was used: ${hosts}`
  );
});

test("a model nobody offers gets the normal answer, not a crash", async () => {
  const res = await chat("no-such-model-anywhere-42");
  assert.ok([400, 404, 503].includes(res.status), `status ${res.status}`);
  assert.equal(hosts.length, 0);
});

test("a stored combo still wins over a bare-name model of the same name", async () => {
  const { createCombo } = await import("../../../src/lib/db/combos.ts");
  await createCombo({
    id: "c1",
    name: "gpt-4o",
    strategy: "priority",
    models: ["openai/gpt-4o"],
  } as never);
  invalidateDbCache();
  const res = await chat("gpt-4o");
  assert.equal(res.status, 200);
  assert.ok(
    hosts.every((h) => h.includes("openai")),
    `the combo pinned openai: ${hosts}`
  );
});

test("the owner's pin for a tenant orders that tenant's own providers", async () => {
  const acme = tenants.createTenant({ slug: "acme" });
  await connect("openai", acme.id);
  await connect("aimlapi", acme.id);
  const key = await createApiKey("acme", "routing-machine");
  tenants.assignApiKeysToTenant(acme.id, [key.id]);
  clearApiKeyCaches();

  rows.setTenantRoutingSide(acme.id, "owner", {
    transparent: false,
    priority: ["openai", "aimlapi"],
  });
  const res = await chat("gpt-4o", key.key);
  assert.equal(res.status, 200, await res.clone().text());
  assert.ok(
    hosts[0].includes("openai"),
    `the tenant's own order won over the instance's: ${hosts}`
  );
});
