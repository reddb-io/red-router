import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
const directory = mkdtempSync(join(tmpdir(), "rr-routing-preview-"));
process.env.DATA_DIR = directory;
process.env.JWT_SECRET = "routing-preview-only-secret";
process.env.API_KEY_SECRET ||= "routing-preview-api-secret";
const { getDbInstance, resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { updateSettings } = await import("../../../src/lib/db/settings.ts");
const { createProviderConnection } = await import("../../../src/lib/db/providers.ts");
const { createApiKey } = await import("../../../src/lib/db/apiKeys.ts");
const tenants = await import("../../../src/lib/db/tenants.ts");
const { mintDashboardSessionToken } =
  await import("../../../src/shared/utils/dashboardSessionToken.ts");
const { GET } = await import("../../../src/app/api/routing/preview/route.ts");
after(() => {
  resetDbInstance();
  rmSync(directory, { recursive: true, force: true });
});

test("routing preview follows the selected key's tenant and model restrictions without dispatch", async () => {
  await updateSettings({
    requireLogin: true,
    transparentModels: false,
    providerPriority: ["openai"],
  });
  const cookie = `auth_token=${await mintDashboardSessionToken(process.env.JWT_SECRET!, "owner")}`;
  const tenant = tenants.createTenant({ slug: "preview" });
  const connection = await createProviderConnection({
    provider: "openai",
    authType: "apikey",
    apiKey: "fake-no-upstream",
    isActive: true,
    name: "Private",
  });
  tenants.assignResourcesToTenant(tenant.id, { connectionIds: [String(connection.id)] });
  const key = await createApiKey("Restricted preview", "routing-preview-machine", [], {
    modelAccessMode: "restricted",
    allowedModels: ["openai/gpt-4o"],
  });
  tenants.assignApiKeysToTenant(tenant.id, [key.id]);
  const query = new URLSearchParams({ apiKeyId: key.id, model: "gpt-4o" });
  const response = await GET(
    new Request(`http://localhost/api/routing/preview?${query}`, { headers: { cookie } })
  );
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.equal(body.scope.tenantId, tenant.id);
  assert.ok(body.targets.length > 0);
  assert.ok(body.targets.every((target: { provider: string }) => target.provider === "openai"));
  assert.ok(!JSON.stringify(body).includes(key.key));
  assert.equal(
    (getDbInstance().prepare("SELECT COUNT(*) AS n FROM usage_history").get() as { n: number }).n,
    0
  );
  query.set("model", "claude-sonnet-4.5");
  const denied = await GET(
    new Request(`http://localhost/api/routing/preview?${query}`, { headers: { cookie } })
  );
  assert.deepEqual((await denied.json()).targets, []);
  const unauthenticated = await GET(new Request("http://localhost/api/routing/preview"));
  assert.equal(unauthenticated.status, 401);
  assert.ok(!(await unauthenticated.text()).includes("at /"));
});
