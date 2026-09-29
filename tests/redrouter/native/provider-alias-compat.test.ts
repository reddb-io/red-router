import assert from "node:assert/strict";
import { test } from "node:test";

const { resolveProviderAlias } = await import("../../../open-sse/services/providerAlias.ts");
const { buildAliasMaps, resolveCanonicalProviderId } =
  await import("../../../src/app/api/v1/models/catalogProviderMaps.ts");

// alias -> provider id, from RedRouter v0.33.0's tests/__baseline__/alias-baseline.json, for the
// aliases this build did not resolve before.
const FRIDAY_ALIASES: Record<string, string> = {
  ocg: "opencode-go",
  qd: "qoder",
  vercel: "vercel-ai-gateway",
  ch: "chutes",
  vx: "vertex",
  vxp: "vertex-partner",
  gcli: "grok-cli",
  gb: "grok-cli",
  "grok-build": "grok-cli",
  pw: "perplexity-web",
  airforce: "api-airforce",
  "llm-7": "llm7",
  kgw: "kilo-gateway",
  hunyuan: "tencent",
  ernie: "baidu",
  morphllm: "morph",
  typesafe: "typesafe-ai",
  // Already kept before this change.
  cmc: "command-code",
  ark: "volcengine-coding-plan",
  xmtp: "xiaomi-mimo-token-plan",
};

test("saved models and combos written with RedRouter v0.33.0 aliases still route", () => {
  for (const [alias, provider] of Object.entries(FRIDAY_ALIASES)) {
    assert.equal(resolveProviderAlias(alias), provider, `routing: ${alias}`);
  }
});

test("the model catalog resolves the same aliases, so listed members match routed ones", () => {
  const { aliasToProviderId } = buildAliasMaps();
  for (const [alias, provider] of Object.entries(FRIDAY_ALIASES)) {
    assert.equal(resolveCanonicalProviderId(aliasToProviderId, alias), provider, `catalog: ${alias}`);
  }
});

test("an alias this build already owns keeps its meaning", () => {
  assert.equal(resolveProviderAlias("cc"), "claude");
  assert.equal(resolveProviderAlias("cx"), "codex");
});
