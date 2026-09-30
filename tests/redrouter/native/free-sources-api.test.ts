import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "redrouter-free-sources-"));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = "test-jwt-secret-for-free-sources";
const { getDbInstance, resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { updateSettings, getSettings } = await import("../../../src/lib/db/settings.ts");
const { createProviderConnection } = await import("../../../src/lib/db/providers.ts");
const { hashManagementPassword } = await import("../../../src/lib/auth/managementPassword.ts");
const { DASHBOARD_SESSION_COOKIE, getDashboardJwtSecret, mintDashboardSessionToken } =
  await import("../../../src/shared/utils/dashboardSessionToken.ts");
const route = await import("../../../src/app/api/providers/free-sources/route.ts");
const { listFreeSourceProviderIds } =
  await import("../../../src/lib/providers/enabledProviders.ts");

after(() => {
  resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

type SourceRow = {
  id: string;
  name: string;
  enabled: boolean;
  hasConnection: boolean;
  kind: string;
};
const url = "http://localhost/api/providers/free-sources";
const post = (body: unknown, headers: Record<string, string> = {}) =>
  route.POST(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  );
const list = async () =>
  (await (await route.GET(new Request(url))).json()) as {
    providers: SourceRow[];
    legacyUsage: string[];
  };
const enabledIds = async () => (await getSettings()).enabledNoAuthProviders as string[];
const auditActions = () =>
  (
    getDbInstance().prepare("SELECT action FROM audit_log ORDER BY id").all() as Array<{
      action: string;
    }>
  ).map((row) => row.action);

test("GET lists every no-auth provider, none enabled by default", async () => {
  const { providers, legacyUsage } = await list();
  assert.ok(providers.length >= 15);
  assert.ok(providers.some((p) => p.id === "aihorde" && p.name.length > 0));
  assert.equal(
    providers.some((p) => p.enabled),
    false
  );
  assert.equal(
    providers.every((p) => p.kind === "available" && !p.hasConnection),
    true
  );
  assert.deepEqual(legacyUsage, []);
});

test("enable and disable edit the list, dropping unknown ids and resolving aliases", async () => {
  const enabled = await post({
    action: "enable",
    providerIds: ["aihorde", "oc", "nope", "openai"],
  });
  assert.equal(enabled.status, 200);
  const body = (await enabled.json()) as {
    enabledNoAuthProviders: string[];
    providers: SourceRow[];
  };
  assert.deepEqual(body.enabledNoAuthProviders, ["aihorde", "opencode"]);
  assert.equal(body.providers.find((p) => p.id === "aihorde")?.kind, "free-optin");
  assert.deepEqual(await enabledIds(), ["aihorde", "opencode"]);

  await post({ action: "disable", providerIds: ["aihorde"] });
  assert.deepEqual(await enabledIds(), ["opencode"]);

  const nothing = await post({ action: "enable", providerIds: ["nope"] });
  assert.equal(nothing.status, 400, "no valid id is rejected");
  assert.deepEqual(await enabledIds(), ["opencode"]);
});

test("enable-all switches on the free sources and disable-all clears the list", async () => {
  const response = await post({ action: "enable-all" });
  assert.equal(response.status, 200);
  assert.deepEqual([...(await enabledIds())].sort(), [...listFreeSourceProviderIds()].sort());
  assert.equal((await enabledIds()).includes("auggie"), false, "local CLI bridges stay opt-in");

  await post({ action: "disable-all" });
  assert.deepEqual(await enabledIds(), []);
});

test("invalid bodies get fixed 4xx errors, never a stack", async () => {
  const badAction = await post({ action: "explode" });
  assert.equal(badAction.status, 400);
  const badId = await post({ action: "enable", providerIds: ["has space"] });
  assert.equal(badId.status, 400);
  const notJson = await route.POST(
    new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{" })
  );
  assert.equal(notJson.status, 400);
  assert.doesNotMatch(await notJson.text(), /at \//);
});

test("every mutation is recorded in the audit log", () => {
  const actions = auditActions();
  for (const action of [
    "provider.free_sources.enable",
    "provider.free_sources.disable",
    "provider.free_sources.enable_all",
    "provider.free_sources.disable_all",
  ]) {
    assert.ok(actions.includes(action), action);
  }
});

test("a connection is reported alongside the enabled flag", async () => {
  await createProviderConnection({
    provider: "uncloseai",
    authType: "apikey",
    name: "Unclose",
    apiKey: "key",
    isActive: true,
    testStatus: "active",
  });
  const row = (await list()).providers.find((p) => p.id === "uncloseai");
  assert.equal(row?.hasConnection, true);
  assert.equal(row?.enabled, false);
  assert.equal(row?.kind, "connected");
});

test("legacyUsage lists free sources with successful traffic in the last 90 days, never enabling them", async () => {
  const db = getDbInstance();
  const insert = db.prepare(
    "INSERT INTO usage_history (provider, model, status, success, timestamp) VALUES (?, ?, ?, ?, ?)"
  );
  const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  insert.run("veoaifree-web", "m", "200", 1, daysAgo(10)); // recent success
  insert.run("oc", "m", "200", 1, daysAgo(3)); // recorded under its alias
  insert.run("duckduckgo-web", "m", "500", 0, daysAgo(2)); // failure only
  insert.run("mimo-free", "m", "200", 1, daysAgo(200)); // too old
  insert.run("openai", "m", "200", 1, daysAgo(1)); // not a no-auth provider
  const { legacyUsage } = await list();
  assert.deepEqual([...legacyUsage].sort(), ["opencode", "veoaifree-web"]);
  assert.deepEqual(await enabledIds(), [], "the hint never enables anything");
});

test("management auth is required once login is on", async () => {
  await updateSettings({
    requireLogin: true,
    password: await hashManagementPassword("correct horse battery staple 42"),
  });
  assert.equal((await route.GET(new Request(url))).status, 401);
  assert.equal((await post({ action: "enable-all" })).status, 401);
  assert.deepEqual(await enabledIds(), [], "an unauthenticated call changes nothing");

  const token = await mintDashboardSessionToken(getDashboardJwtSecret());
  const cookie = `${DASHBOARD_SESSION_COOKIE}=${token}`;
  assert.equal((await route.GET(new Request(url, { headers: { cookie } }))).status, 200);
  assert.equal(
    (await post({ action: "enable", providerIds: ["aihorde"] }, { cookie })).status,
    200
  );
  assert.deepEqual(await enabledIds(), ["aihorde"]);
});
