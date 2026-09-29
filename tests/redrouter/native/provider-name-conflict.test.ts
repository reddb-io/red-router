import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { makeManagementSessionRequest } from "../../helpers/managementSession.ts";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "redrouter-provider-conflict-"));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = "test-jwt-secret-for-provider-conflict";
process.env.INITIAL_PASSWORD = "admin-secret";

const core = await import("../../../src/lib/db/core.ts");
const route = await import("../../../src/app/api/providers/route.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const create = async (body: Record<string, unknown>) =>
  route.POST(
    await makeManagementSessionRequest("http://localhost/api/providers", { method: "POST", body })
  );

test("a second key under the same provider and name is refused, not swapped in silently", async () => {
  const first = await create({ provider: "synthetic", name: "Main", apiKey: "key-one" });
  assert.equal(first.status, 201);
  const id = ((await first.json()) as { connection: { id: string } }).connection.id;

  const second = await create({ provider: "synthetic", name: "Main", apiKey: "key-two" });
  assert.equal(second.status, 409);
  const body = (await second.json()) as { code: string; existingId: string };
  assert.equal(body.code, "PROVIDER_NAME_CONFLICT");
  assert.equal(body.existingId, id);
});

test("a different name, or an explicit overwrite, still works", async () => {
  const other = await create({ provider: "synthetic", name: "Second", apiKey: "key-three" });
  assert.equal(other.status, 201);
  const overwrite = await create({
    provider: "synthetic",
    name: "Main",
    apiKey: "key-four",
    allowOverwrite: true,
  });
  assert.equal(overwrite.status, 201);
});
