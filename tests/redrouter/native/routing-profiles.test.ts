import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "redrouter-routing-profiles-"));
process.env.DATA_DIR = dir;
process.env.API_KEY_SECRET = "routing-profiles-test-secret";
const { getDbInstance, resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { updateSettings } = await import("../../../src/lib/db/settings.ts");
const profiles = await import("../../../src/lib/db/routingProfiles.ts");
const tenants = await import("../../../src/lib/db/tenants.ts");
const rows = await import("../../../src/lib/db/routingPolicy.ts");
const { resolveRoutingPolicy } = await import("../../../src/lib/routing/routingPolicy.ts");
const { describeEffectivePolicy } = await import("../../../src/lib/routing/effectivePolicy.ts");
const { getModelCatalogCacheVersion } = await import("../../../src/lib/db/readCache.ts");
after(() => {
  resetDbInstance();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  for (const table of ["routing_profile_bindings", "routing_profiles", "tenant_routing_policy"])
    getDbInstance().prepare(`DELETE FROM ${table}`).run();
  getDbInstance().prepare("DELETE FROM tenants WHERE is_default = 0").run();
  await updateSettings({
    transparentModels: true,
    providerPriority: ["openai"],
    delegateRoutingToTenants: true,
  });
});

test("profiles are opt-in and editing a shared profile preserves independent local pins", async () => {
  const a = tenants.createTenant({ slug: "alpha" });
  const b = tenants.createTenant({ slug: "bravo" });
  const profile = profiles.saveRoutingProfile({
    name: "Shared",
    transparent: false,
    providerPriority: ["groq", "openai"],
  });
  assert.equal(
    (await resolveRoutingPolicy(a.id)).transparent,
    true,
    "creating a profile does not activate it"
  );
  profiles.setRoutingProfileBinding(profile.id, a.id);
  profiles.setRoutingProfileBinding(profile.id, b.id);
  rows.setTenantRoutingSide(b.id, "owner", { transparent: true, priority: [] });
  rows.setTenantRoutingSide(a.id, "tenant", { transparent: true, priority: ["openai"] });
  assert.equal(
    (await resolveRoutingPolicy(a.id)).transparent,
    false,
    "owner profile beats delegated tenant"
  );
  const version = getModelCatalogCacheVersion();
  profiles.saveRoutingProfile(
    { name: "Shared revised", transparent: true, providerPriority: ["openrouter"] },
    profile.id
  );
  assert.ok(getModelCatalogCacheVersion() > version, "profile updates invalidate discovery");
  const next = await resolveRoutingPolicy(a.id);
  assert.deepEqual(next.providerPriority, ["openrouter"]);
  assert.equal(next.profiles?.transparent?.name, "Shared revised");
  const pinned = await resolveRoutingPolicy(b.id);
  assert.deepEqual(
    pinned.providerPriority,
    [],
    "an explicit empty local order overrides a non-empty profile"
  );
  assert.equal(pinned.profiles?.transparent, null);
  const snapshot = describeEffectivePolicy(next, null, null, []);
  assert.equal(snapshot.rows[0].source, "Owner pin for this tenant · Profile: Shared revised");
  assert.equal(profiles.listRoutingProfiles()[0].attachments, 2);
});

test("partial profiles inherit fields and instance overrides can return to shared settings", async () => {
  const profile = profiles.saveRoutingProfile({
    name: "Visibility only",
    transparent: false,
    providerPriority: null,
  });
  profiles.setRoutingProfileBinding(profile.id);
  let policy = await resolveRoutingPolicy();
  assert.deepEqual(policy.providerPriority, ["openai"]);
  assert.equal(policy.profiles?.providerPriority, null);
  profiles.setInstanceProfileOverrides({ transparent: true, providerPriority: [] });
  policy = await resolveRoutingPolicy();
  assert.equal(policy.transparent, true);
  assert.deepEqual(policy.providerPriority, []);
  assert.equal(policy.profiles?.transparent, null);
  profiles.setInstanceProfileOverrides({ transparent: null, providerPriority: null });
  assert.equal((await resolveRoutingPolicy()).transparent, false);
  profiles.setRoutingProfileBinding(null);
  assert.equal((await resolveRoutingPolicy()).transparent, true);
  assert.deepEqual((await resolveRoutingPolicy()).providerPriority, ["openai"]);
});

test("attached deletion is blocked and deleting a tenant removes its attachment", () => {
  const tenant = tenants.createTenant({ slug: "alpha" });
  const profile = profiles.saveRoutingProfile({
    name: "Shared",
    transparent: false,
    providerPriority: null,
  });
  profiles.setRoutingProfileBinding(profile.id, tenant.id);
  assert.throws(
    () => profiles.deleteRoutingProfile(profile.id),
    (error: unknown) => error instanceof profiles.RoutingProfileError && error.status === 409
  );
  assert.ok(profiles.getRoutingProfile(profile.id));
  assert.throws(() => profiles.setRoutingProfileBinding("missing", tenant.id));
  assert.equal(profiles.getRoutingProfileBinding(tenant.id)?.profileId, profile.id);
  tenants.deleteTenant(tenant.id);
  assert.equal(profiles.listRoutingProfiles()[0].attachments, 0);
  profiles.deleteRoutingProfile(profile.id);
  assert.equal(profiles.getRoutingProfile(profile.id), null);
});
