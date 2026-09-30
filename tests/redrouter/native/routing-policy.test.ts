import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "redrouter-routing-policy-"));
process.env.DATA_DIR = dataDir;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "routing-policy-test-secret";

const { getDbInstance, resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { updateSettings } = await import("../../../src/lib/db/settings.ts");
const tenants = await import("../../../src/lib/db/tenants.ts");
const rows = await import("../../../src/lib/db/routingPolicy.ts");
const policy = await import("../../../src/lib/routing/routingPolicy.ts");

after(() => {
  resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

let acme: { id: string };
beforeEach(async () => {
  const db = getDbInstance();
  db.prepare("DELETE FROM tenant_routing_policy").run();
  db.prepare("DELETE FROM tenants WHERE is_default = 0").run();
  await updateSettings({
    transparentModels: true,
    providerPriority: [],
    delegateRoutingToTenants: false,
  });
  acme = tenants.createTenant({ slug: "acme" });
});

test("by default the list is transparent, with no priority, and tenants are not delegated", async () => {
  const p = await policy.resolveRoutingPolicy(acme.id);
  assert.deepEqual([p.transparent, p.providerPriority, p.delegated], [true, [], false]);
  assert.deepEqual(p.source, { transparent: "instance", providerPriority: "instance" });
  assert.equal((await policy.resolveRoutingPolicy(null)).transparent, true);
});

test("the owner's instance policy applies to a tenant with nothing of its own", async () => {
  await updateSettings({ transparentModels: false, providerPriority: ["kiro", "openai"] });
  const p = await policy.resolveRoutingPolicy(acme.id);
  assert.deepEqual([p.transparent, p.providerPriority], [false, ["kiro", "openai"]]);
  assert.equal((await policy.resolveRoutingPolicy("red")).transparent, false);
  assert.equal((await policy.resolveRoutingPolicy(null)).transparent, false);
});

test("a tenant's own choice is ignored until the owner delegates", async () => {
  await updateSettings({ transparentModels: false, providerPriority: ["kiro"] });
  rows.setTenantRoutingSide(acme.id, "tenant", { transparent: true, priority: ["openai"] });
  const locked = await policy.resolveRoutingPolicy(acme.id);
  assert.deepEqual(
    [locked.transparent, locked.providerPriority],
    [false, ["kiro"]],
    "the owner has the last word"
  );
  assert.equal(locked.source.transparent, "instance");

  await updateSettings({ delegateRoutingToTenants: true });
  const delegated = await policy.resolveRoutingPolicy(acme.id);
  assert.deepEqual([delegated.transparent, delegated.providerPriority], [true, ["openai"]]);
  assert.deepEqual(delegated.source, { transparent: "tenant", providerPriority: "tenant" });

  await updateSettings({ delegateRoutingToTenants: false });
  assert.equal(
    (await policy.resolveRoutingPolicy(acme.id)).transparent,
    false,
    "taking delegation back restores the owner's policy"
  );
});

test("what the owner pinned for a tenant beats the tenant's choice, even while delegated", async () => {
  await updateSettings({ delegateRoutingToTenants: true, transparentModels: true });
  rows.setTenantRoutingSide(acme.id, "tenant", { transparent: true, priority: ["openai"] });
  rows.setTenantRoutingSide(acme.id, "owner", { transparent: false, priority: ["groq", "kiro"] });
  const p = await policy.resolveRoutingPolicy(acme.id);
  assert.deepEqual([p.transparent, p.providerPriority], [false, ["groq", "kiro"]]);
  assert.deepEqual(p.source, { transparent: "owner", providerPriority: "owner" });
});

test("mode and priority resolve independently", async () => {
  await updateSettings({
    delegateRoutingToTenants: true,
    transparentModels: true,
    providerPriority: ["a"],
  });
  rows.setTenantRoutingSide(acme.id, "owner", { transparent: false });
  rows.setTenantRoutingSide(acme.id, "tenant", { transparent: true, priority: ["b", "c"] });
  const p = await policy.resolveRoutingPolicy(acme.id);
  assert.equal(p.transparent, false, "the owner pinned the mode");
  assert.deepEqual(p.providerPriority, ["b", "c"], "the tenant may still order its providers");
  assert.deepEqual(p.source, { transparent: "owner", providerPriority: "tenant" });
});

test("clearing what the owner pinned hands control back", async () => {
  await updateSettings({ delegateRoutingToTenants: true });
  rows.setTenantRoutingSide(acme.id, "tenant", { transparent: false });
  rows.setTenantRoutingSide(acme.id, "owner", { transparent: true });
  assert.equal((await policy.resolveRoutingPolicy(acme.id)).transparent, true);
  rows.setTenantRoutingSide(acme.id, "owner", { transparent: null });
  assert.equal((await policy.resolveRoutingPolicy(acme.id)).transparent, false);
});

test("writing one side never disturbs the other", () => {
  rows.setTenantRoutingSide(acme.id, "owner", { transparent: false, priority: ["x"] });
  const after = rows.setTenantRoutingSide(acme.id, "tenant", { transparent: true });
  assert.deepEqual(
    [after.ownerTransparent, after.ownerPriority, after.tenantTransparent, after.tenantPriority],
    [false, ["x"], true, null]
  );
});

test("priority lists are cleaned: unique, trimmed, bounded, strings only", () => {
  assert.deepEqual(
    policy.normalizeProviderPriority([" kiro ", "Kiro", "openai", "", 5, null, "openai"]),
    ["kiro", "openai"]
  );
  assert.deepEqual(policy.normalizeProviderPriority("nope"), []);
  assert.equal(
    policy.normalizeProviderPriority(Array.from({ length: 500 }, (_, i) => `p${i}`)).length,
    300
  );
});
