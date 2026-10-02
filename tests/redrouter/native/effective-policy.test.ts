import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describeEffectivePolicy,
  type AccessPolicyInput,
} from "../../../src/lib/routing/effectivePolicy.ts";
import type { RoutingPolicy } from "../../../src/lib/routing/routingPolicy.ts";

const policy: RoutingPolicy = {
  transparent: false,
  providerPriority: ["karavela", "openrouter"],
  source: { transparent: "owner", providerPriority: "tenant" },
  delegated: true,
};
const key: AccessPolicyInput = {
  modelAccessMode: "restricted",
  allowedModels: ["karavela/glm-5.3-flash"],
  blockedModels: [],
  allowedConnections: ["mine", "foreign"],
  allowedEndpoints: ["/v1/chat/completions"],
  cacheDefaultMode: "bypass",
  streamDefaultMode: "json",
};

test("effective policy explains independent owner and tenant precedence and projects no secrets", () => {
  const snapshot = describeEffectivePolicy(
    policy,
    key,
    { ...key, allowedConnections: ["mine"] },
    [
      {
        id: "mine",
        provider: "karavela",
        name: "Private gateway",
        isActive: true,
        apiKey: "secret",
        providerSpecificData: { baseUrl: "https://user:password@example.invalid" },
        rateLimitedUntil: "2030-01-01T00:00:00Z",
        testStatus: "unavailable",
      },
      { id: "foreign", provider: "karavela", name: "Hidden account", isActive: true },
    ],
    Date.parse("2026-10-02T00:00:00Z")
  );
  assert.equal(snapshot.rows[0].source, "Owner pin for this tenant");
  assert.equal(snapshot.rows[1].source, "Tenant choice (delegated by owner)");
  assert.equal(snapshot.rows[1].value, "karavela → openrouter");
  assert.equal(snapshot.connectionSource, "API key intersected with tenant boundary");
  assert.deepEqual(
    snapshot.connections.map((connection) => connection.id),
    ["mine"]
  );
  assert.equal(snapshot.connections[0].cooldownUntil, "2030-01-01T00:00:00Z");
  assert.equal(snapshot.connections[0].testStatus, "unavailable");
  assert.ok(!JSON.stringify(snapshot).includes("secret"));
  assert.ok(!JSON.stringify(snapshot).includes("password"));
  assert.deepEqual(key.allowedConnections, ["mine", "foreign"]);
});

test("a tenant with no accounts stays denied; expired cooldown does not imply a tested model", () => {
  const connections = [
    { id: "mine", provider: "karavela", isActive: 0, rateLimitedUntil: "2020-01-01T00:00:00Z" },
  ];
  assert.deepEqual(
    describeEffectivePolicy(
      policy,
      key,
      {
        ...key,
        allowedConnections: ["tenant:no-connections"],
      },
      connections
    ).connections,
    []
  );
  const snapshot = describeEffectivePolicy(policy, null, null, connections);
  assert.equal(snapshot.connections[0].enabled, false);
  assert.equal(snapshot.connections[0].cooldownUntil, null);
  assert.equal(snapshot.connections[0].testStatus, null);
  assert.equal(snapshot.access, null);
});
