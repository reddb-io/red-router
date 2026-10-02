import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { makeManagementSessionRequest } from "../../helpers/managementSession.ts";

const dataDir = mkdtempSync(join(tmpdir(), "redrouter-manual-probe-"));
const originalDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = dataDir;
const core = await import("../../../src/lib/db/core.ts");
const providers = await import("../../../src/lib/db/providers.ts");
const route = await import("../../../src/app/api/providers/[id]/test/route.ts");
const batchRoute = await import("../../../src/app/api/providers/test-batch/route.ts");
const originalFetch = globalThis.fetch;
after(async () => {
  globalThis.fetch = originalFetch;
  await core.shutdownDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

test("manual HTTP probes bypass a saved cooldown; drafts and failed tests leave saved health unchanged", async () => {
  const cooldown = new Date(Date.now() + 3600000).toISOString();
  const created = await providers.createProviderConnection({
    provider: "red-router",
    authType: "apikey",
    apiKey: "saved-key",
    name: "Remote router",
    isActive: true,
    testStatus: "unavailable",
    rateLimitedUntil: cooldown,
    lastError: "Old transient failure",
    lastErrorType: "network_error",
    providerSpecificData: { baseUrl: "http://10.0.0.2:25050/v1" },
  });
  const id = String(created.id);
  const before = await providers.getProviderConnectionById(id);
  assert.equal(before.rateLimitedUntil, cooldown);
  let status = 200;
  const calls: Array<{ url: string; auth: string | null }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
    return Response.json({ data: [{ id: "openrouter/typesafe/jev" }] }, { status });
  }) as typeof fetch;
  const call = async (body: Record<string, unknown>) => {
    const request = await makeManagementSessionRequest(
      `http://localhost/api/providers/${id}/test`,
      { method: "POST", body }
    );
    const response = await route.POST(request, { params: Promise.resolve({ id }) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const preview = await call({
    draft: { baseUrl: "http://10.0.0.3:25050/v1", apiKey: "replacement-key" },
  });
  assert.equal(preview.valid, true);
  assert.equal(preview.preview, true);
  assert.equal(calls[0].url, "http://10.0.0.3:25050/v1/models");
  assert.equal(calls[0].auth, "Bearer replacement-key");
  assert.deepEqual(await providers.getProviderConnectionById(id), before);
  status = 401;
  const failure = await call({});
  assert.equal(failure.valid, false);
  assert.equal(failure.statusCode, 401);
  assert.ok(calls.some((entry) => entry.url === "http://10.0.0.2:25050/v1/models"));
  assert.deepEqual(
    await providers.getProviderConnectionById(id),
    before,
    "manual failure must not introduce or extend cooldown"
  );
  const batchRequest = await makeManagementSessionRequest(
    "http://localhost/api/providers/test-batch",
    {
      method: "POST",
      body: { mode: "selected", connectionIds: [id] },
    }
  );
  const batchResponse = await batchRoute.POST(batchRequest);
  assert.equal(batchResponse.status, 200);
  const batch = await batchResponse.json();
  assert.equal(batch.results[0].valid, false);
  assert.equal(batch.results[0].statusCode, 401);
  assert.deepEqual(
    await providers.getProviderConnectionById(id),
    before,
    "batch diagnostics also preserve cooldown"
  );
  status = 200;
  assert.equal((await call({})).valid, true);
  const recovered = await providers.getProviderConnectionById(id);
  assert.ok(recovered.rateLimitedUntil == null, "the stored cooldown was cleared");
  assert.equal(recovered.testStatus, "active");
  assert.equal(recovered.apiKey, "saved-key");
  assert.equal(
    (recovered.providerSpecificData as Record<string, unknown>).baseUrl,
    "http://10.0.0.2:25050/v1"
  );
});

test("successful and unsupported diagnostics cannot opt an inactive connection into routing", async () => {
  globalThis.fetch = (async () => Response.json({ data: [{ id: "model" }] })) as typeof fetch;
  for (const provider of ["red-router", "unsupported-opt-in-test-provider"]) {
    const connection = await providers.createProviderConnection({
      provider,
      authType: "apikey",
      apiKey: "test-key",
      providerSpecificData: { baseUrl: "http://10.0.0.2:25050/v1" },
    });
    const id = String(connection.id);
    assert.equal(connection.isActive, false);
    const request = await makeManagementSessionRequest(
      `http://localhost/api/providers/${id}/test`,
      { method: "POST", body: {} }
    );
    const response = await route.POST(request, { params: Promise.resolve({ id }) });
    assert.equal(response.status, 200);
    const body = await response.json();
    if (provider === "red-router") assert.equal(body.valid, true);
    else assert.equal(body.skipped, true);
    assert.equal((await providers.getProviderConnectionById(id)).isActive, false);
  }
});
