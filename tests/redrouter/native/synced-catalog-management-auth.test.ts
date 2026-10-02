import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
const dir = mkdtempSync(join(tmpdir(), "redrouter-catalog-auth-"));
process.env.DATA_DIR = dir;
const core = await import("../../../src/lib/db/core.ts");
const { updateSettings } = await import("../../../src/lib/db/settings.ts");
const { getMachineTokenSync } = await import("../../../src/lib/machineToken.ts");
const { GET } = await import("../../../src/app/api/synced-available-models/route.ts");
after(() => {
  core.resetDbInstance();
  rmSync(dir, { recursive: true, force: true });
});

test("catalog accepts the same local machine credential as model tests, without allowing remote use", async () => {
  await updateSettings({ requireLogin: true, password: "fixture-password-hash" });
  const token = getMachineTokenSync();
  assert.ok(token);
  const request = (peer: string, credential = token) => {
    const req = new Request("http://localhost/api/synced-available-models?provider=openrouter", {
      headers: { "x-omniroute-cli-token": credential },
    });
    Object.assign(req, { socket: { remoteAddress: peer } });
    return req;
  };
  const accepted = await GET(request("127.0.0.1"));
  assert.equal(accepted.status, 200);
  const catalog = await accepted.json();
  assert.ok(Array.isArray(catalog.models));
  assert.ok(Array.isArray(catalog.decisionModels));
  for (const denied of [request("192.0.2.1"), request("127.0.0.1", "invalid")]) {
    const response = await GET(denied);
    assert.equal(response.status, 401);
    assert.ok(!(await response.text()).includes("at /"));
  }
});
