import assert from "node:assert/strict";
import { readRoutingStorageConfig } from "../../src/lib/db/repositories/routingStorageConfig.ts";
import { createRoutingConfigRepositories } from "../../src/lib/db/repositories/routingConfigRepositories.ts";

const config = readRoutingStorageConfig({
  RED_ROUTER_ROUTING_BACKEND: process.env.RED_ROUTER_TEST_BACKEND,
  RED_ROUTER_ROUTING_DATABASE_URL: process.env.RED_ROUTER_TEST_DATABASE_URL,
});
assert.notEqual(config.backend, "sqlite");
const repos = createRoutingConfigRepositories(config);
try {
  if (process.argv[2] === "seed") {
    await repos.combos.create({
      id: "redrouter-ci-restart",
      name: "redrouter-ci-restart",
      description: "Quote ' and slash \\ and café",
      models: [{ provider: "openai", model: "gpt-4.1" }],
    });
    await repos.modelComboMappings.create({
      pattern: "restart-*",
      comboId: "redrouter-ci-restart",
    });
  } else {
    assert.equal(process.argv[2], "verify");
    const combo = await repos.combos.findById("redrouter-ci-restart");
    assert.ok(combo);
    assert.equal(combo.description, "Quote ' and slash \\ and café");
    assert.equal(combo.version, 2);
    const resolved = await repos.modelComboMappings.resolveForModel("restart-probe");
    assert.equal(resolved?.id, combo.id);
    console.log("Routing configuration survived database restart");
  }
} finally {
  await repos.close();
}
