import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const taskDir = mkdtempSync(join(tmpdir(), "redrouter-embedding-report-"));
process.env.DATA_DIR = taskDir;
const { getDbInstance, resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { createApiKey } = await import("../../../src/lib/db/apiKeys.ts");
const { recordEmbeddingUsage } = await import("../../../src/lib/embeddings/usage.ts");

after(() => {
  delete process.env.REDROUTER_USAGE_REPORT_ALL_REQUESTS;
  resetDbInstance();
  rmSync(taskDir, { recursive: true, force: true });
});

test("embedding usage is durable, key-scoped, zero-price opt-in and idempotent", async () => {
  const key = await createApiKey("embedding report", "embedding-report-test", [], {
    usageAttributes: { project_id: "project-a", resource_id: "resource-a" },
  });
  const input = {
    apiKeyId: key.id,
    provider: "unpriced-test-provider",
    model: "embedding-test",
    usage: { total_tokens: 42 },
    requestId: "embedding-request-a",
  };
  delete process.env.REDROUTER_USAGE_REPORT_ALL_REQUESTS;
  await recordEmbeddingUsage(input);
  await new Promise((resolve) => setImmediate(resolve));
  const query = () =>
    getDbInstance()
      .prepare("SELECT * FROM request_cost_ledger WHERE request_id = ?")
      .all(input.requestId) as Array<Record<string, unknown>>;
  assert.equal(query().length, 0);
  process.env.REDROUTER_USAGE_REPORT_ALL_REQUESTS = "true";
  await recordEmbeddingUsage(input);
  await recordEmbeddingUsage(input);
  await new Promise((resolve) => setImmediate(resolve));
  const rows = query();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].api_key_id, key.id);
  assert.equal(rows[0].tokens_input, 42);
  assert.equal(rows[0].tokens_output, 0);
  assert.equal(rows[0].pricing_known, 0);
  assert.deepEqual(JSON.parse(String(rows[0].usage_attributes)), {
    project_id: "project-a",
    resource_id: "resource-a",
  });
  assert.equal(JSON.stringify(rows).includes(key.key), false);
});
