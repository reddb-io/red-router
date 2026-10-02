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
const { hashManagementPassword } = await import("../../../src/lib/auth/managementPassword.ts");
const { createProviderConnection } = await import("../../../src/lib/db/providers.ts");
const { createApiKey, updateApiKeyPermissions } = await import("../../../src/lib/db/apiKeys.ts");
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
    password: await hashManagementPassword("routing-preview-owner-fixture-2026"),
    transparentModels: false,
    providerPriority: ["openai"],
  });
  const cookie = `auth_token=${await mintDashboardSessionToken(new TextEncoder().encode(process.env.JWT_SECRET!), "owner")}`;
  const tenant = tenants.createTenant({ slug: "preview" });
  const connection = await createProviderConnection({
    provider: "openai",
    authType: "apikey",
    apiKey: "fake-no-upstream",
    isActive: true,
    name: "Private",
  });
  const { activateFixtureModels } = await import("../../helpers/modelActivationFixtures.ts");
  await activateFixtureModels("openai", ["gpt-6-astra"]);
  tenants.assignResourcesToTenant(tenant.id, { connectionIds: [String(connection.id)] });
  const excluded = await createProviderConnection({
    provider: "openai",
    authType: "apikey",
    apiKey: "never-expose-this-credential",
    isActive: true,
    name: "Outside tenant scope",
  });
  const key = await createApiKey("Restricted preview", "routing-preview-machine", [], {
    modelAccessMode: "restricted",
    allowedModels: ["openai/gpt-6-astra"],
  });
  tenants.assignApiKeysToTenant(tenant.id, [key.id]);
  await updateApiKeyPermissions(key.id, { cacheDefaultMode: "bypass", streamDefaultMode: "json" });
  const query = new URLSearchParams({ apiKeyId: key.id, model: "gpt-6-astra" });
  const response = await GET(
    new Request(`http://localhost/api/routing/preview?${query}`, { headers: { cookie } })
  );
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.equal(body.scope.tenantId, tenant.id);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(
    body.effectivePolicy.rows.find((row: { id: string }) => row.id === "cache-default").value,
    "Bypass"
  );
  assert.equal(
    body.effectivePolicy.rows.find((row: { id: string }) => row.id === "stream-default").value,
    "JSON by default"
  );
  assert.equal(body.effectivePolicy.connectionSource, "Tenant boundary");
  assert.deepEqual(
    body.effectivePolicy.connections.map((item: { id: string }) => item.id),
    [connection.id]
  );
  assert.ok(
    !body.effectivePolicy.connections.some((item: { id: string }) => item.id === excluded.id)
  );
  assert.ok(body.targets.length > 0);
  assert.ok(body.targets.every((target: { provider: string }) => target.provider === "openai"));
  assert.ok(
    body.targets.every(
      (target: { upstreamModel: string }) => target.upstreamModel === "gpt-6-astra"
    )
  );
  assert.ok(!JSON.stringify(body).includes(key.key));
  assert.ok(!JSON.stringify(body).includes("fake-no-upstream"));
  assert.ok(!JSON.stringify(body).includes("never-expose-this-credential"));
  assert.equal(
    (getDbInstance().prepare("SELECT COUNT(*) AS n FROM usage_history").get() as { n: number }).n,
    0
  );
  query.set("model", "claude-sonnet-5-5");
  const denied = await GET(
    new Request(`http://localhost/api/routing/preview?${query}`, { headers: { cookie } })
  );
  assert.deepEqual((await denied.json()).targets, []);
  const unauthenticated = await GET(new Request("http://localhost/api/routing/preview"));
  assert.equal(unauthenticated.status, 401);
  assert.ok(!(await unauthenticated.text()).includes("at /"));
});
