import assert from "node:assert/strict";
import { test } from "node:test";

import {
  getProviderAvailabilityKind,
  getProviderSection,
  isNoAuthCapableProvider,
  isNoAuthProviderEnabled,
  isProviderEnabled,
  listFreeSourceProviderIds,
  listNoAuthProviderIds,
  listNotEnabledNoAuthKeys,
  normalizeEnabledNoAuthProviders,
} from "../../../src/lib/providers/enabledProviders.ts";

test("the no-auth list covers registry no-auth, anonymous gateways and keyless endpoints", () => {
  const ids = listNoAuthProviderIds();
  for (const id of [
    "aihorde",
    "uncloseai",
    "veoaifree-web",
    "opencode",
    "opencode-zen",
    "opencode-go",
  ])
    assert.ok(ids.includes(id), id);
  for (const id of ["duckduckgo-free", "context7", "pollinations", "kilocode"])
    assert.ok(ids.includes(id), id);
  // Keyed and local providers are never no-auth: they need a connection.
  for (const id of ["openai", "ollama-local", "lm-studio", "claude", "serper-search"])
    assert.equal(ids.includes(id), false, id);
});

test("free sources exclude the local CLI bridges", () => {
  const free = listFreeSourceProviderIds();
  assert.ok(free.includes("aihorde"));
  for (const id of ["devin-cli-agentic", "auggie", "zcode", "codex-app-server"])
    assert.equal(free.includes(id), false, id);
});

test("isNoAuthProviderEnabled truth table", () => {
  assert.equal(isNoAuthProviderEnabled("aihorde", {}), false);
  assert.equal(isNoAuthProviderEnabled("aihorde", undefined), false);
  assert.equal(isNoAuthProviderEnabled("aihorde", { enabledNoAuthProviders: [] }), false);
  assert.equal(isNoAuthProviderEnabled("aihorde", { enabledNoAuthProviders: "aihorde" }), false);
  assert.equal(isNoAuthProviderEnabled("aihorde", { enabledNoAuthProviders: ["aihorde"] }), true);
  assert.equal(
    isNoAuthProviderEnabled("aihorde", { enabledNoAuthProviders: ["uncloseai"] }),
    false
  );
  // Aliases resolve to the canonical id in both directions.
  assert.equal(isNoAuthProviderEnabled("oc", { enabledNoAuthProviders: ["opencode"] }), true);
  assert.equal(isNoAuthProviderEnabled("opencode", { enabledNoAuthProviders: ["oc"] }), true);
  // Enabling OpenCode Free also enables the gateways serving the same endpoint, not vice versa.
  const oc = { enabledNoAuthProviders: ["opencode"] };
  assert.equal(isNoAuthProviderEnabled("opencode-zen", oc), true);
  assert.equal(isNoAuthProviderEnabled("opencode-go", oc), true);
  assert.equal(
    isNoAuthProviderEnabled("opencode", { enabledNoAuthProviders: ["opencode-zen"] }),
    false
  );
  // A keyed provider can never be "enabled" through the list.
  assert.equal(isNoAuthProviderEnabled("openai", { enabledNoAuthProviders: ["openai"] }), false);
});

test("isProviderEnabled: a connection or an explicit enable, nothing else", () => {
  const off = { enabledNoAuthProviders: [] };
  const on = { enabledNoAuthProviders: ["aihorde"] };
  const cases: Array<[string, boolean, object, boolean]> = [
    ["openai", false, off, false],
    ["openai", true, off, true],
    ["ollama-local", false, off, false],
    ["ollama-local", true, off, true],
    ["aihorde", false, off, false],
    ["aihorde", false, on, true],
    ["aihorde", true, off, true],
    ["uncloseai", false, on, false],
  ];
  for (const [providerId, hasActiveConnection, settings, expected] of cases) {
    assert.equal(
      isProviderEnabled({ providerId, hasActiveConnection, settings }),
      expected,
      `${providerId} conn=${hasActiveConnection} ${JSON.stringify(settings)}`
    );
  }
});

test("availability kind is connected, free-optin or available", () => {
  const on = { enabledNoAuthProviders: ["aihorde"] };
  const kind = (providerId: string, hasActiveConnection: boolean, settings: object) =>
    getProviderAvailabilityKind({ providerId, hasActiveConnection, settings });
  assert.equal(kind("openai", true, {}), "connected");
  assert.equal(kind("aihorde", true, on), "connected");
  assert.equal(kind("aihorde", false, on), "free-optin");
  assert.equal(kind("aihorde", false, {}), "available");
  assert.equal(kind("openai", false, on), "available");
});

test("normalisation resolves aliases, drops unknown and keyed ids, and de-duplicates", () => {
  assert.deepEqual(
    normalizeEnabledNoAuthProviders(["oc", "opencode", "AIHORDE", "nope", "openai", "aihorde", 7]),
    ["opencode", "aihorde"]
  );
  assert.deepEqual(normalizeEnabledNoAuthProviders("aihorde"), []);
  assert.deepEqual(normalizeEnabledNoAuthProviders(undefined), []);
});

test("not-enabled keys cover ids and aliases of unconnected, unenabled no-auth providers", () => {
  const keys = listNotEnabledNoAuthKeys({ enabledNoAuthProviders: ["opencode"] }, ["uncloseai"]);
  assert.ok(keys.includes("aihorde"));
  assert.equal(keys.includes("uncloseai"), false, "connected providers are not blocked");
  assert.equal(keys.includes("opencode"), false);
  assert.equal(keys.includes("oc"), false);
  assert.equal(keys.includes("opencode-zen"), false, "sibling gateways follow OpenCode Free");
  assert.equal(keys.includes("openai"), false);
  const all = listNotEnabledNoAuthKeys({}, []);
  assert.ok(all.includes("oc") && all.includes("opencode"));
});

test("providers are classified by registry section", () => {
  assert.equal(getProviderSection("aihorde"), "no-auth");
  assert.equal(getProviderSection("claude"), "oauth");
  assert.equal(getProviderSection("openai"), "apikey");
  assert.equal(getProviderSection("ollama-local"), "local");
  assert.equal(getProviderSection("context7"), "search");
  assert.equal(getProviderSection("openai-compatible-abc"), "compatible-node");
  assert.equal(getProviderSection("does-not-exist"), "unknown");
  assert.equal(isNoAuthCapableProvider("aihorde"), true);
  assert.equal(isNoAuthCapableProvider("ollama-local"), false);
});
