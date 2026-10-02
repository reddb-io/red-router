import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "redrouter-model-effort-"));
process.env.DATA_DIR = dir;
const FLAG = "OMNIROUTE_DISABLE_THINKING_LEVEL_VARIANTS";
const originalEnv = process.env[FLAG];
delete process.env[FLAG];

const { resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { removeFeatureFlagOverride, setFeatureFlagOverride } =
  await import("../../../src/lib/db/featureFlags.ts");
const { applyCatalogPostFilters, finalizeCatalogResponse } =
  await import("../../../src/app/api/v1/models/catalogResponse.ts");
const { resolveCachedCatalogResponse, __resetCatalogBuilderRunsForTest } =
  await import("../../../src/app/api/v1/models/catalogCache.ts");
const { applyClaudeEffortVariant } =
  await import("../../../open-sse/handlers/chatCore/claudeEffortVariant.ts");
const { openaiToClaudeRequest } =
  await import("../../../open-sse/translator/request/openai-to-claude.ts");
const { markTransparentCatalogRequest } =
  await import("../../../src/app/api/v1/models/catalogTransparency.ts");
const { orderedTargetsFor } = await import("../../../src/lib/routing/bareModels.ts");

test.beforeEach(() => {
  removeFeatureFlagOverride(FLAG);
  __resetCatalogBuilderRunsForTest();
});
test.after(() => {
  resetDbInstance();
  rmSync(dir, { recursive: true, force: true });
  if (originalEnv === undefined) delete process.env[FLAG];
  else process.env[FLAG] = originalEnv;
});

const context = {
  connections: [],
  prefixMode: "dual",
  aliasToProviderId: {},
  hideNoThinkVariants: true,
};
const entry = (owner: string, prefix: string, root: string) => ({
  id: `${prefix}${root}`,
  root,
  owned_by: owner,
  type: "chat",
});
const baseModels = [
  entry("command-code", "cmd/", "claude-fable-5-1"),
  { ...entry("openai", "openai/", "reasoner"), capabilities: { effort_tiers: ["high"] } },
];
const request = () => new Request("http://localhost/v1/models");

test("default discovery lists base models and keeps declared effort metadata", async () => {
  const snapshot = structuredClone(baseModels);
  const out = await applyCatalogPostFilters(request(), baseModels, context);
  assert.deepEqual(
    out.map((model) => model.id),
    baseModels.map((model) => model.id)
  );
  assert.deepEqual(out[1].capabilities, { effort_tiers: ["high"] });
  assert.deepEqual(baseModels, snapshot, "discovery must not mutate the source catalog");
  const response = await finalizeCatalogResponse(request(), out, () => undefined, {});
  const body = await response.json();
  const fable = body.data.find((model: { id: string }) => model.id === baseModels[0].id);
  assert.equal(fable.capabilities.supportsThinking, true);
  assert.ok(fable.capabilities.effort_tiers.includes("xhigh"));
});

test("registered Codex and GLM parameter aliases collapse only within the same visible route", async () => {
  for (const [owner, prefix, root, tier] of [
    ["codex", "codex/", "gpt-6-astra", "ultra"],
    ["codex", "cx/", "gpt-6-luna", "max"],
    ["codex", "", "gpt-5.5", "xhigh"],
    ["codex-app-server", "cxa/", "gpt-6-sol", "high"],
    ["glm", "glm/", "glm-5.3", "max"],
    ["glm-cn", "glm-cn/", "glm-5.3-flash", "high"],
    ["glmt", "glmt/", "glm-5.3", "low"],
  ]) {
    const models = [entry(owner, prefix, root), entry(owner, prefix, `${root}-${tier}`)];
    const out = await applyCatalogPostFilters(request(), models, context);
    assert.deepEqual(
      out.map((model) => model.id),
      [models[0].id]
    );
    // A scoped key, provider model exclusion or hidden base must never lose its
    // only remaining selection. A base in another prefix doesn't authorize it.
    const aliasOnly = await applyCatalogPostFilters(request(), [models[1]], context);
    assert.deepEqual(
      aliasOnly.map((model) => model.id),
      [models[1].id]
    );
  }
  const separateRoutes = [
    entry("codex", "codex/", "gpt-6-astra"),
    entry("codex", "cx/", "gpt-6-astra-high"),
  ];
  assert.deepEqual(
    await applyCatalogPostFilters(request(), separateRoutes, context),
    separateRoutes
  );
});

test("native suffix IDs, remote IDs and GLM 5.2 transport aliases remain visible", async () => {
  const native = [
    entry("cursor", "cu/", "claude-fable-5-1"),
    entry("cursor", "cu/", "claude-fable-5-1-xhigh"),
    entry("devin-cli-agentic", "dva/", "claude-fable-5-1"),
    entry("devin-cli-agentic", "dva/", "claude-fable-5-1-high"),
    entry("glm", "glm/", "glm-5.2"),
    entry("glm", "glm/", "glm-5.2-high"),
    entry("openrouter", "openrouter/", "vendor/native"),
    entry("openrouter", "openrouter/", "vendor/native-high"),
    { ...entry("codex", "red/codex/", "gpt-6-astra"), remoteCapabilities: {} },
    { ...entry("codex", "red/codex/", "gpt-6-astra-high"), remoteCapabilities: {} },
    { ...entry("codex", "codex/", "gpt-6-astra"), type: "embedding" },
    { ...entry("codex", "codex/", "gpt-6-astra-high"), type: "embedding" },
  ];
  assert.deepEqual(await applyCatalogPostFilters(request(), native, context), native);
});

test("configuredOnly preserves an alias whose base is excluded by the connection", async () => {
  const base = entry("codex", "cx/", "gpt-6-astra");
  const alias = entry("codex", "cx/", "gpt-6-astra-high");
  const out = await applyCatalogPostFilters(
    new Request("http://localhost/v1/models?configuredOnly=true"),
    [base, alias],
    { ...context, connections: [{ providerSpecificData: { excludedModels: [base.root] } }] }
  );
  assert.deepEqual(
    out.map((model) => model.id),
    [alias.id]
  );
});

test("existing environment configuration and explicit operator overrides retain precedence", async () => {
  process.env[FLAG] = "false";
  try {
    const visible = await applyCatalogPostFilters(request(), baseModels, context);
    assert.ok(visible.some((model) => model.id === "openai/reasoner-high"));
    setFeatureFlagOverride(FLAG, "true");
    const hidden = await applyCatalogPostFilters(request(), baseModels, context);
    assert.deepEqual(
      hidden.map((model) => model.id),
      baseModels.map((model) => model.id)
    );
  } finally {
    delete process.env[FLAG];
  }
});

test("the compatibility override restores aliases without bypassing key permissions", async () => {
  setFeatureFlagOverride(FLAG, "false");
  const models = [
    ...baseModels,
    entry("codex", "cx/", "gpt-6-sol"),
    entry("codex", "cx/", "gpt-6-sol-high"),
  ];
  const out = await applyCatalogPostFilters(request(), models, context);
  const ids = out.map((model) => model.id);
  assert.ok(ids.includes("cmd/claude-fable-5-1-xhigh"));
  assert.ok(ids.includes("openai/reasoner-high"));
  assert.ok(ids.includes("cx/gpt-6-sol-high"));
  const scoped = await applyCatalogPostFilters(request(), baseModels, {
    ...context,
    authorizeSyntheticModel: () => false,
  });
  assert.deepEqual(
    scoped.map((model) => model.id),
    baseModels.map((model) => model.id)
  );
});

test("changing compatibility invalidates a cached catalog immediately", async () => {
  let builds = 0;
  const read = async () => {
    const response = await resolveCachedCatalogResponse(
      request(),
      { corsHeaders: {}, diagnosticHeaders: {} },
      async (req) => {
        builds++;
        const data = await applyCatalogPostFilters(req, baseModels, context);
        return {
          body: JSON.stringify({ object: "list", data }),
          status: 200,
          headers: {},
          cacheTTL: 60000,
        };
      }
    );
    return (await response.json()).data.map((model: { id: string }) => model.id);
  };
  assert.deepEqual(
    await read(),
    baseModels.map((model) => model.id)
  );
  await read();
  assert.equal(builds, 1);
  setFeatureFlagOverride(FLAG, "false");
  assert.ok((await read()).includes("openai/reasoner-high"));
  assert.equal(builds, 2);
  setFeatureFlagOverride(FLAG, "true");
  assert.deepEqual(
    await read(),
    baseModels.map((model) => model.id)
  );
  assert.equal(builds, 3);
});

test("private routing discovery keeps legacy aliases without changing the public catalog", async () => {
  const models = [
    ...baseModels,
    entry("codex", "cx/", "gpt-6-sol"),
    entry("codex", "cx/", "gpt-6-sol-high"),
  ];
  const internal = await applyCatalogPostFilters(
    markTransparentCatalogRequest(request()),
    models,
    context
  );
  assert.ok(internal.some((model) => model.id === "cmd/claude-fable-5-1-xhigh"));
  assert.ok(internal.some((model) => model.id === "cx/gpt-6-sol-high"));
  assert.deepEqual(orderedTargetsFor(internal, "claude-fable-5-1-xhigh", []), [
    { id: "cmd/claude-fable-5-1-xhigh", provider: "command-code" },
  ]);
  assert.deepEqual(orderedTargetsFor(internal, "gpt-6-sol-high", []), [
    { id: "cx/gpt-6-sol-high", provider: "codex" },
  ]);
  const external = await applyCatalogPostFilters(
    new Request("http://localhost/v1/models?transparent=true"),
    models,
    context
  );
  assert.ok(!external.some((model) => model.id === "cmd/claude-fable-5-1-xhigh"));
  assert.ok(!external.some((model) => model.id === "cx/gpt-6-sol-high"));
});

test("the base model plus effort translates to Anthropic adaptive thinking", () => {
  const body = {
    model: "claude-fable-5-1",
    reasoning_effort: "xhigh",
    max_tokens: 8000,
    messages: [{ role: "user", content: "Solve this" }],
  };
  const out = openaiToClaudeRequest(body.model, body, false);
  assert.equal(out.model, body.model);
  assert.deepEqual(out.thinking, { type: "adaptive", display: "summarized" });
  assert.equal(out.output_config.effort, "xhigh");
  assert.equal(out.thinking.budget_tokens, undefined);
});

test("hidden legacy Claude aliases still normalize, and explicit effort wins", () => {
  const body: Record<string, unknown> = { model: "claude-fable-5-1-xhigh" };
  const normalize = (payload: Record<string, unknown>, sourceFormat = "openai") =>
    applyClaudeEffortVariant({
      provider: "claude",
      effectiveModel: "claude-fable-5-1-xhigh",
      body: payload,
      sourceFormat,
    });
  assert.equal(normalize(body).effectiveModel, "claude-fable-5-1");
  assert.equal(body.reasoning_effort, "xhigh");
  for (const explicit of [
    { reasoning_effort: "low" },
    { reasoning: { effort: "low" } },
    { output_config: { effort: "low" } },
  ]) {
    const payload = { ...explicit, model: "claude-fable-5-1-xhigh" };
    normalize(payload);
    assert.deepEqual(payload, { ...explicit, model: "claude-fable-5-1" });
  }
  const native = {
    model: "claude-fable-5-1-xhigh",
    thinking: { type: "adaptive" },
    output_config: { effort: "low" },
  };
  normalize(native, "claude");
  assert.deepEqual(native.thinking, { type: "adaptive" });
  assert.deepEqual(native.output_config, { effort: "low" });
  assert.equal("reasoning_effort" in native, false);
});
