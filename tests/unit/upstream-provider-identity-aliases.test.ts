import test from "node:test";
import assert from "node:assert/strict";

import { getRegistryEntry, REGISTRY } from "../../open-sse/config/providerRegistry.ts";
import { getModelUpstreamId } from "../../open-sse/config/providerModels.ts";
import { getExecutor, hasSpecializedExecutor } from "../../open-sse/executors/index.ts";
import { parseModel } from "../../open-sse/services/model.ts";
import { ALIAS_TO_ID, resolveProviderId } from "../../src/shared/constants/providers.ts";
import { resolveProviderCompatibilityAlias } from "../../src/shared/constants/providerCompatibilityAliases.ts";

test("9router Volcengine Ark ID resolves only to the Coding Plan product", async () => {
  const oldId = "volcengine-ark";
  const canonical = "volcengine-coding-plan";
  assert.equal(resolveProviderCompatibilityAlias(oldId), canonical);
  assert.equal(resolveProviderId(oldId), canonical);
  assert.equal(ALIAS_TO_ID[oldId], canonical);
  assert.equal(parseModel(`${oldId}/DeepSeek-V4-Flash`).provider, canonical);
  assert.equal(getRegistryEntry(oldId), REGISTRY[canonical]);
  assert.equal(getRegistryEntry(oldId)?.baseUrl, REGISTRY[canonical].baseUrl);
  assert.equal(getRegistryEntry(oldId)?.baseUrl?.includes("/api/coding/v3/"), true);
  assert.equal(REGISTRY[oldId], undefined, "do not create a duplicate connection product");

  assert.equal(resolveProviderCompatibilityAlias("ark"), canonical);
  assert.equal(resolveProviderId("ark"), canonical);
  assert.equal(ALIAS_TO_ID.ark, canonical);
  assert.equal(parseModel("ark/GLM-5.1").provider, canonical);
  assert.equal(getRegistryEntry("ark"), REGISTRY[canonical]);
  assert.equal(REGISTRY.ark, undefined, "the short alias must not duplicate the product");
  assert.equal(hasSpecializedExecutor(oldId), false);
  assert.equal((await getExecutor(oldId)).provider, canonical);
});

test("compatible 9router Ark model IDs use the Coding Plan wire IDs", () => {
  for (const [publicId, upstreamId] of [
    ["Doubao-Seed-2.0-lite", "doubao-seed-2.0-lite"],
    ["DeepSeek-V4-Flash", "deepseek-v4-flash"],
    ["DeepSeek-V4-Pro", "deepseek-v4-pro"],
    ["MiniMax-M2.7", "minimax-m2.7"],
    ["Kimi-K2.6", "kimi-k2.6"],
  ]) {
    const parsed = parseModel(`volcengine-ark/${publicId}`);
    assert.equal(parsed.provider, "volcengine-coding-plan");
    assert.equal(parsed.model, publicId);
    assert.ok(parsed.provider && parsed.model);
    assert.equal(getModelUpstreamId(parsed.provider, parsed.model), upstreamId);
    assert.ok(REGISTRY["volcengine-coding-plan"].models.some((model) => model.id === upstreamId));
  }
  for (const unverifiedId of [
    "Doubao-Seed-2.0-Code",
    "Doubao-Seed-2.0-pro",
    "Doubao-Seed-Code",
    "GLM-5.1",
  ]) {
    assert.ok(REGISTRY["volcengine-coding-plan"].models.some((model) => model.id === unverifiedId));
    assert.equal(parseModel(`ark/${unverifiedId}`).model, unverifiedId);
    assert.equal(getModelUpstreamId("volcengine-coding-plan", unverifiedId), null);
  }
});

test("9router Xiaomi Token Plan IDs resolve only to the regional tp-key product", async () => {
  const canonical = "xiaomi-mimo-token-plan";
  for (const oldId of ["xiaomi-tokenplan", "xmtp"]) {
    assert.equal(resolveProviderCompatibilityAlias(oldId), canonical);
    assert.equal(resolveProviderId(oldId), canonical);
    assert.equal(ALIAS_TO_ID[oldId], canonical);
    assert.equal(parseModel(`${oldId}/mimo-v2.5-pro`).provider, canonical);
    assert.equal(getRegistryEntry(oldId), REGISTRY[canonical]);
    assert.equal((await getExecutor(oldId)).provider, canonical);
    assert.equal(REGISTRY[oldId], undefined, "do not duplicate Token Plan accounts");
  }
  assert.match(getRegistryEntry(canonical)?.baseUrl || "", /token-plan-sgp\.xiaomimimo\.com/);
  assert.notEqual(resolveProviderId("xiaomi-mimo"), canonical);
});

test("distinct Windsurf and Qoder CN products do not alias existing transports", () => {
  for (const [upstreamId, localId] of [
    ["windsurf", "devin-desktop"],
    ["ws", "devin-desktop"],
    ["qoder-cn", "qoder"],
    ["qdcn", "qoder"],
  ]) {
    assert.notEqual(resolveProviderCompatibilityAlias(upstreamId), localId);
    assert.notEqual(resolveProviderId(upstreamId), localId);
    assert.notEqual(ALIAS_TO_ID[upstreamId], localId);
  }
});

test("GitLab Duo Chat is not aliased to the public Code Suggestions products", () => {
  // 9router's hidden `gitlab` entry declares the internal /chat/completions API.
  // The existing local identities instead use Code Suggestions; name overlap
  // must not be mistaken for a compatible request or response contract.
  assert.equal(resolveProviderCompatibilityAlias("gitlab"), "gitlab");
  assert.equal(resolveProviderId("gitlab"), "gitlab");
  assert.equal(resolveProviderId("gitlab-duo"), "gitlab-duo");
  assert.equal(ALIAS_TO_ID.gitlab, "gitlab");
  assert.equal(REGISTRY["gitlab"], undefined);
  assert.match(REGISTRY["gitlab-duo"].baseUrl ?? "", /\/api\/v4\/code_suggestions\/completions$/);
});
