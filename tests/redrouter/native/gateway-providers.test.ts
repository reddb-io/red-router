import assert from "node:assert/strict";
import test from "node:test";

const { REGISTRY } = await import("../../../open-sse/config/providerRegistry.ts");
const { AI_PROVIDERS, AGGREGATOR_PROVIDER_IDS } =
  await import("../../../src/shared/constants/providers.ts");
const { DefaultExecutor } = await import("../../../open-sse/executors/default.ts");
const { buildCloudflareAiGatewayChatUrl, buildGatewayExtraHeaders } =
  await import("../../../open-sse/config/gatewayProviders.ts");
const { validateProviderApiKey } = await import("../../../src/lib/providers/validation.ts");

const GATEWAYS = ["cloudflare-ai-gateway", "helicone", "portkey"] as const;
const CF_BASE = "https://gateway.ai.cloudflare.com/v1/acct123/gw456";

const creds = (apiKey: string, psd: Record<string, unknown> = {}) =>
  ({ apiKey, providerSpecificData: psd }) as never;
const headersOf = (provider: string, apiKey: string, psd: Record<string, unknown> = {}) =>
  new DefaultExecutor(provider).buildHeaders(creds(apiKey, psd), false) as Record<string, string>;
const urlOf = (provider: string, psd: Record<string, unknown> = {}) =>
  new DefaultExecutor(provider).buildUrl("m", false, 0, creds("k", psd));

test("the three gateways are registered as OpenAI-format, key-authenticated, user-named-model upstreams", () => {
  for (const id of GATEWAYS) {
    const entry = REGISTRY[id];
    assert.ok(entry, id);
    assert.equal(entry.id, id);
    assert.equal(entry.format, "openai");
    assert.equal(entry.authType, "apikey");
    assert.equal(entry.authHeader, "bearer");
    assert.equal(entry.passthroughModels, true);
    assert.deepEqual(entry.models, []);
    assert.match(entry.baseUrl, /^https:\/\//);
    assert.equal("apiKey" in entry, false, "no credential in the registry");
  }
});

test("registry ids and aliases are unique across the whole registry", () => {
  const seen = new Map<string, string>();
  for (const [id, entry] of Object.entries(REGISTRY) as [string, { alias?: string }][]) {
    for (const key of [id, entry.alias]) {
      if (!key) continue;
      const owner = seen.get(key);
      // A provider may reuse its own id as alias; anyone else claiming the key is a collision.
      assert.ok(!owner || owner === id, `${key} claimed by ${owner} and ${id}`);
      seen.set(key, id);
    }
  }
  assert.equal(REGISTRY["cloudflare-ai-gateway"].alias, "cfaig");
  assert.notEqual(REGISTRY["cloudflare-ai-gateway"].alias, REGISTRY["cloudflare-ai"].alias);
});

test("the dashboard catalog matches the registry for each gateway", () => {
  for (const id of GATEWAYS) {
    const provider = (AI_PROVIDERS as Record<string, Record<string, unknown>>)[id];
    assert.ok(provider, id);
    assert.equal(provider.alias, REGISTRY[id].alias);
    assert.equal(provider.passthroughModels, true);
    assert.deepEqual(provider.serviceKinds, ["llm"]);
    assert.ok(AGGREGATOR_PROVIDER_IDS.has(id), `${id} groups with the gateways`);
    assert.match(String(provider.website), /^https:\/\//);
  }
});

test("Helicone has a live models URL; Portkey and Cloudflare do not guess one", () => {
  assert.equal(REGISTRY.helicone.modelsUrl, "https://ai-gateway.helicone.ai/v1/models");
  assert.equal(REGISTRY.portkey.modelsUrl, undefined);
  assert.equal(REGISTRY["cloudflare-ai-gateway"].modelsUrl, undefined);
});

test("Cloudflare AI Gateway builds the chat URL from the per-account base URL", () => {
  assert.equal(
    urlOf("cloudflare-ai-gateway", { baseUrl: `${CF_BASE}/openai` }),
    `${CF_BASE}/openai/chat/completions`
  );
  assert.equal(
    urlOf("cloudflare-ai-gateway", { baseUrl: `${CF_BASE}/compat/` }),
    `${CF_BASE}/compat/chat/completions`
  );
  // Bare account/gateway root means the unified endpoint.
  assert.equal(
    urlOf("cloudflare-ai-gateway", { baseUrl: CF_BASE }),
    `${CF_BASE}/compat/chat/completions`
  );
  // A pasted full endpoint is used as-is, never given an extra /v1.
  assert.equal(
    urlOf("cloudflare-ai-gateway", { baseUrl: `${CF_BASE}/openai/chat/completions` }),
    `${CF_BASE}/openai/chat/completions`
  );
  assert.equal(buildCloudflareAiGatewayChatUrl(""), "");
});

test("Cloudflare AI Gateway refuses to dispatch without the account URL", () => {
  assert.throws(() => urlOf("cloudflare-ai-gateway"), /needs a Base URL/);
  assert.throws(() => urlOf("cloudflare-ai-gateway", { baseUrl: "   " }), /needs a Base URL/);
});

test("Helicone and Portkey default to their documented OpenAI-compatible endpoints", () => {
  assert.equal(urlOf("helicone"), "https://ai-gateway.helicone.ai/v1/chat/completions");
  assert.equal(urlOf("portkey"), "https://api.portkey.ai/v1/chat/completions");
});

test("Helicone authenticates with a plain Bearer key and no gateway extras", () => {
  const headers = headersOf("helicone", "sk-helicone-test");
  assert.equal(headers.Authorization, "Bearer sk-helicone-test");
  assert.equal(
    Object.keys(headers).some((h) => h.toLowerCase().startsWith("x-portkey")),
    false
  );
});

test("Portkey sends its key as Bearer and x-portkey-api-key, plus the optional virtual key", () => {
  const plain = headersOf("portkey", "pk-test");
  assert.equal(plain.Authorization, "Bearer pk-test");
  assert.equal(plain["x-portkey-api-key"], "pk-test");
  assert.equal("x-portkey-virtual-key" in plain, false);

  const virtual = headersOf("portkey", "pk-test", { virtualKey: "vk-openai" });
  assert.equal(virtual["x-portkey-virtual-key"], "vk-openai");
  assert.equal(
    headersOf("portkey", "pk", { portkeyVirtualKey: "vk-2" })["x-portkey-virtual-key"],
    "vk-2"
  );
});

test("Cloudflare cf-aig-authorization is supported as an optional connection setting", () => {
  const open = headersOf("cloudflare-ai-gateway", "sk-upstream");
  assert.equal(open.Authorization, "Bearer sk-upstream");
  assert.equal("cf-aig-authorization" in open, false);

  const authed = headersOf("cloudflare-ai-gateway", "sk-upstream", { cfAigToken: "cf-token" });
  assert.equal(authed["cf-aig-authorization"], "Bearer cf-token");
  assert.equal(authed.Authorization, "Bearer sk-upstream");
});

test("gateway extras ignore unsafe values and other providers", () => {
  assert.deepEqual(buildGatewayExtraHeaders("portkey", "k", { virtualKey: "a\r\nx-evil: 1" }), {
    "x-portkey-api-key": "k",
  });
  assert.deepEqual(buildGatewayExtraHeaders("portkey", "bad\nkey", {}), {});
  assert.deepEqual(
    buildGatewayExtraHeaders("openai", "k", { virtualKey: "v", cfAigToken: "t" }),
    {}
  );
  assert.deepEqual(buildGatewayExtraHeaders(null, "k", {}), {});
  // The header only comes from connection data, never the process environment.
  assert.deepEqual(buildGatewayExtraHeaders("cloudflare-ai-gateway", "k", null), {});
});

test("validating a Cloudflare AI Gateway key without a Base URL explains what is missing", async () => {
  const result = (await validateProviderApiKey({
    provider: "cloudflare-ai-gateway",
    apiKey: "sk-test",
    providerSpecificData: {},
  })) as { valid: boolean; error?: string };
  assert.equal(result.valid, false);
  assert.match(String(result.error), /Base URL/);
});
