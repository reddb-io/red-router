import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const helpers =
  await import("../../../src/app/(dashboard)/dashboard/providers/[id]/providerSettingsHelpers.ts");

const DEFAULT = "http://127.0.0.1:25050/v1";
const withDefault = { defaultBaseUrl: DEFAULT, baseUrlConfigurable: true };
const noDefault = { defaultBaseUrl: "", baseUrlConfigurable: true };

test("the destination always shows for a provider that has one, and is 'Default' until changed", () => {
  const rows = helpers.connectionConfigRows({ providerSpecificData: {} }, withDefault);
  assert.equal(rows.length, 1);
  assert.deepEqual(
    [rows[0].key, rows[0].value, rows[0].overridden, rows[0].resettable],
    ["baseUrl", DEFAULT, false, false]
  );
  // A trailing slash is not a change.
  const same = helpers.connectionConfigRows(
    { providerSpecificData: { baseUrl: `${DEFAULT}/` } },
    withDefault
  );
  assert.equal(same[0].overridden, false);
});

test("a changed destination is 'Custom' and can be reset to the default", () => {
  const conn = { providerSpecificData: { baseUrl: "http://10.0.0.7:25050/v1" } };
  const [row] = helpers.connectionConfigRows(conn, withDefault);
  assert.deepEqual(
    [row.value, row.overridden, row.resettable, row.defaultValue],
    ["http://10.0.0.7:25050/v1", true, true, DEFAULT]
  );
  assert.deepEqual(helpers.resettableKeys(conn, withDefault), ["baseUrl"]);
  assert.equal(helpers.hasOverrides(conn, withDefault), true);
});

test("a provider with no built-in host is never reset to nothing", () => {
  const conn = { providerSpecificData: { baseUrl: "https://my-app.modal.run/v1" } };
  const [row] = helpers.connectionConfigRows(conn, noDefault);
  assert.equal(row.overridden, true);
  assert.equal(row.resettable, false, "clearing it would leave the connection with nowhere to go");
  assert.deepEqual(helpers.resettableKeys(conn, noDefault), []);
});

test("group tag, routing tags and excluded models show only when set, and are resettable", () => {
  const conn = {
    providerSpecificData: {
      tag: " work ",
      tags: ["fast", "eu"],
      excludedModels: ["gpt-4o-mini"],
      region: "eu",
    },
  };
  const rows = helpers.connectionConfigRows(conn, {
    defaultBaseUrl: "",
    baseUrlConfigurable: false,
  });
  assert.deepEqual(
    rows.map((row: { key: string; value: string }) => [row.key, row.value]),
    [
      ["tag", "work"],
      ["tags", "fast, eu"],
      ["excludedModels", "gpt-4o-mini"],
    ]
  );
  assert.deepEqual(
    helpers.resettableKeys(conn, { defaultBaseUrl: "", baseUrlConfigurable: false }),
    ["tag", "tags", "excludedModels"]
  );
  assert.deepEqual(
    helpers.connectionConfigRows(
      { providerSpecificData: {} },
      { defaultBaseUrl: "", baseUrlConfigurable: false }
    ),
    []
  );
  assert.deepEqual(
    helpers.connectionConfigRows({}, { defaultBaseUrl: "", baseUrlConfigurable: false }),
    []
  );
});

test("the reset body only ever names the resettable keys, as nulls", () => {
  assert.deepEqual(helpers.buildResetBody(["baseUrl", "tag"]), {
    providerSpecificData: { baseUrl: null, tag: null },
  });
  assert.deepEqual(
    helpers.buildResetBody(["baseUrl", "apiKey", "extraApiKeys", "region", "connectionProxy"]),
    { providerSpecificData: { baseUrl: null } },
    "credentials and required fields are refused"
  );
  assert.deepEqual(helpers.buildResetBody([]), { providerSpecificData: {} });
});

test("the confirmation says what changes", () => {
  const conn = { providerSpecificData: { baseUrl: "http://10.0.0.7:25050/v1", tag: "work" } };
  const rows = helpers.connectionConfigRows(conn, withDefault);
  assert.deepEqual(helpers.describeReset(rows, ["baseUrl", "tag"]), [
    `Destination: http://10.0.0.7:25050/v1 → ${DEFAULT}`,
    "Group tag: work → cleared",
  ]);
});

// The real endpoint: the merge keeps everything the reset does not name.
const dataDir = mkdtempSync(join(tmpdir(), "redrouter-provider-reset-"));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = "test-jwt-secret-for-provider-reset";
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "provider-reset-test-secret";
const { resetDbInstance } = await import("../../../src/lib/db/core.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");
const { DASHBOARD_SESSION_COOKIE, getDashboardJwtSecret, mintDashboardSessionToken } =
  await import("../../../src/shared/utils/dashboardSessionToken.ts");
const route = await import("../../../src/app/api/providers/[id]/route.ts");
after(() => {
  resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

test("PUT with the reset body clears the overrides and keeps credentials and other settings", async () => {
  const created = (await providersDb.createProviderConnection({
    provider: "red-router",
    authType: "apikey",
    name: "Remote",
    apiKey: "sk-remote-secret",
    providerSpecificData: { baseUrl: "http://10.0.0.7:25050/v1", tag: "work", region: "eu" },
  })) as { id: string };

  const cookie = `${DASHBOARD_SESSION_COOKIE}=${await mintDashboardSessionToken(getDashboardJwtSecret()!)}`;
  const res = await route.PUT(
    new Request(`http://localhost/api/providers/${created.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(helpers.buildResetBody(["baseUrl", "tag"])),
    }),
    { params: Promise.resolve({ id: created.id }) }
  );
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json().catch(() => null)));

  const after = (await providersDb.getProviderConnectionById(created.id)) as {
    apiKey: string;
    providerSpecificData: Record<string, unknown>;
  };
  const psd = after.providerSpecificData;
  assert.ok(!psd.baseUrl, "the destination override is gone (null or absent)");
  assert.ok(!psd.tag, "the tag is gone");
  assert.equal(psd.region, "eu", "settings the reset did not name are kept");
  assert.equal(after.apiKey, "sk-remote-secret", "the credential is untouched");
  // What the panel shows next: back to Default.
  const [row] = helpers.connectionConfigRows(after, withDefault);
  assert.deepEqual([row.value, row.overridden], [DEFAULT, false]);
});
