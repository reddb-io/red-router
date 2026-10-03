import assert from "node:assert/strict";
import test from "node:test";
import { resolveTopologyProviderLabel } from "../../../src/app/(dashboard)/home/topologyLabel.ts";

const provider = "openai-compatible-chat-02669115-2545-4896-b003-cb4dac09d441";

test("uses the connection name even when provider-node discovery is unavailable", () => {
  assert.equal(
    resolveTopologyProviderLabel(provider, [], [{ provider, name: "Karavela" }], provider),
    "Karavela"
  );
});

test("enabled connection names win over generic provider names, without disabled credentials", () => {
  assert.equal(
    resolveTopologyProviderLabel(
      provider,
      [{ id: provider, name: "OAI-COMPAT" }],
      [
        { provider, name: " Karavela " },
        { provider, name: "Karavela" },
        { provider, name: "Backup" },
        { provider, name: "Disabled", isActive: false },
        { provider: "openai", name: "Unrelated" },
      ],
      provider
    ),
    "Karavela, Backup"
  );
});

test("uses the current node name or stored node name for unnamed connections", () => {
  const connections = [{ provider, providerSpecificData: { nodeName: "Old name" } }];
  assert.equal(
    resolveTopologyProviderLabel(
      provider,
      [{ id: provider, name: "Karavela" }],
      connections,
      provider
    ),
    "Karavela"
  );
  assert.equal(resolveTopologyProviderLabel(provider, [], connections, provider), "Old name");
});

test("matches compatible identities case-insensitively and preserves user capitalization", () => {
  assert.equal(
    resolveTopologyProviderLabel(
      provider.toUpperCase(),
      [],
      [{ provider, name: "Karavela" }],
      provider
    ),
    "Karavela"
  );
});

test("preserves built-in provider labels and meaningful compatible fallbacks", () => {
  assert.equal(
    resolveTopologyProviderLabel(
      "openai",
      [],
      [{ provider: "openai", name: "Private key" }],
      "OpenAI"
    ),
    "OpenAI"
  );
  assert.equal(resolveTopologyProviderLabel(provider, [], [], provider), "OAI-COMPAT");
  const anthropic = provider.replace("openai-compatible-", "anthropic-compatible-");
  assert.equal(
    resolveTopologyProviderLabel(
      anthropic,
      [],
      [{ provider: anthropic, name: "Team Claude" }],
      anthropic
    ),
    "Team Claude"
  );
});
