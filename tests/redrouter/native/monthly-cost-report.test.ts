import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "redrouter-monthly-costs-"));
process.env.DATA_DIR = dir;
process.env.JWT_SECRET = "monthly-report-fixture-jwt";
process.env.API_KEY_SECRET ||= "monthly-report-fixture-key";
const { getDbInstance, resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { getMonthlyCostReport, monthlyUsageWindow } =
  await import("../../../src/lib/db/monthlyCostReport.ts");
const { getTenantMonthlyUsage } = await import("../../../src/lib/db/tenantUsage.ts");
const { createTenant, assignApiKeysToTenant } = await import("../../../src/lib/db/tenants.ts");
const { createApiKey, deleteApiKey } = await import("../../../src/lib/db/apiKeys.ts");
const { recordLedgerEntry } = await import("../../../src/lib/db/costLedger.ts");
const { saveRequestUsage } = await import("../../../src/lib/usage/usageHistory.ts");
const { updateSettings } = await import("../../../src/lib/db/settings.ts");
const { hashManagementPassword } = await import("../../../src/lib/auth/managementPassword.ts");
const { mintDashboardSessionToken, getDashboardJwtSecret, DASHBOARD_SESSION_COOKIE } =
  await import("../../../src/shared/utils/dashboardSessionToken.ts");
const route = await import("../../../src/app/api/usage/monthly-report/route.ts");
const analyticsRoute = await import("../../../src/app/api/usage/analytics/route.ts");

after(() => {
  resetDbInstance();
  rmSync(dir, { recursive: true, force: true });
});

test("unknown amounts stay null; explicit zero entries stay zero; sources never multiply each other", async () => {
  const tenant = createTenant({ slug: "monthly-a", name: "Monthly A" });
  const unknown = await createApiKey("Unknown pricing", "monthly-fixture", []);
  const zero = await createApiKey("Recorded zero", "monthly-fixture", []);
  const paid = await createApiKey("Metered", "monthly-fixture", []);
  assignApiKeysToTenant(tenant.id, [unknown.id, zero.id, paid.id]);
  for (const [index, apiKeyId] of [unknown.id, zero.id, paid.id, paid.id].entries()) {
    await saveRequestUsage({
      apiKeyId,
      apiKeyName: "Original key",
      provider: "openai",
      model: "fixture",
      timestamp: `2026-09-01T00:00:0${index}.000Z`,
      tokens: { input_tokens: 20, output_tokens: 5 },
      success: true,
    });
  }
  recordLedgerEntry({
    apiKeyId: zero.id,
    provider: "openai",
    model: "fixture",
    amountUsd: 0,
    timestamp: "2026-09-01T00:00:00.000Z",
  });
  for (const amountUsd of [0.25, 0.5, 0.75])
    recordLedgerEntry({
      apiKeyId: paid.id,
      provider: "openai",
      model: "fixture",
      amountUsd,
      success: amountUsd !== 0.75,
      timestamp: "2026-09-30T23:59:59.999Z",
    });
  recordLedgerEntry({
    apiKeyId: paid.id,
    provider: "openai",
    model: "fixture",
    amountUsd: 99,
    timestamp: "2026-10-01T00:00:00.000Z",
  });
  const report = getMonthlyCostReport("2026-09", { tenantId: tenant.id });
  assert.equal(report.keys.find((row) => row.apiKeyId === unknown.id)?.recordedCostUsd, null);
  assert.equal(report.keys.find((row) => row.apiKeyId === zero.id)?.recordedCostUsd, 0);
  assert.equal(report.total.requests, 4);
  assert.equal(report.total.ledgerEntries, 4);
  assert.equal(report.total.recordedCostUsd, 1.5, "failed charges count; October is excluded");
  assert.equal(
    report.total.recordedCostUsd,
    report.keys.reduce((sum, row) => sum + (row.recordedCostUsd ?? 0), 0)
  );
  assert.equal(
    getMonthlyCostReport("2026-09", { apiKeyIds: [unknown.id] }).total.recordedCostUsd,
    null
  );
  assert.equal(getMonthlyCostReport("2026-09", { apiKeyIds: [paid.id] }).total.requests, 2);
  const legacy = getTenantMonthlyUsage(tenant.id, "2026-09");
  assert.deepEqual(legacy.reconciliation, report);
  assert.equal(legacy.total.pricedRequests, report.total.ledgerEntries);
  assert.match(report.coverage, /not pricing coverage/);
});

test("event ownership survives moves/deletion and the global sum reconciles with tenants and unattributed rows", async () => {
  const a = createTenant({ slug: "move-a" });
  const b = createTenant({ slug: "move-b" });
  const key = await createApiKey("Moved key", "monthly-fixture", []);
  const write = async (timestamp: string) => {
    await saveRequestUsage({
      apiKeyId: key.id,
      apiKeyName: "Moved key",
      provider: "openai",
      model: "fixture",
      timestamp,
      tokens: { input_tokens: 1 },
      success: true,
    });
    recordLedgerEntry({
      apiKeyId: key.id,
      provider: "openai",
      model: "fixture",
      amountUsd: 0.25,
      timestamp,
    });
  };
  assignApiKeysToTenant(a.id, [key.id]);
  await write("2026-08-15T12:00:00.000Z");
  assignApiKeysToTenant(b.id, [key.id]);
  await write("2026-08-15T12:00:01.000Z");
  recordLedgerEntry({
    apiKeyId: "deleted-before-migration",
    provider: "unknown",
    model: "unknown",
    amountUsd: 0.5,
    timestamp: "2026-08-15T12:00:00.000Z",
  });
  await deleteApiKey(key.id);
  const report = getMonthlyCostReport("2026-08");
  const unattributed = report.keys.find((row) => row.tenantId === null)!;
  assert.equal(unattributed.tenantName, "Unattributed tenant");
  assert.equal(unattributed.recordedCostUsd, 0.5);
  assert.equal(unattributed.requests, 0, "ledger-only events remain visible");
  const aTotal = getMonthlyCostReport("2026-08", { tenantId: a.id }).total;
  const bTotal = getMonthlyCostReport("2026-08", { tenantId: b.id }).total;
  assert.equal(aTotal.requests, 1);
  assert.equal(bTotal.requests, 1);
  assert.equal(
    report.total.recordedCostUsd,
    aTotal.recordedCostUsd! + bTotal.recordedCostUsd! + unattributed.recordedCostUsd!
  );
  assert.equal(report.keys.find((row) => row.apiKeyId === key.id)?.current, false);
  assert.equal(
    getMonthlyCostReport("2026-08", { tenantId: a.id, apiKeyIds: ["not-owned"] }).keys.length,
    0
  );
});

test("monthly UTC windows, report authorization and invalid queries have bounded sanitized responses", async () => {
  assert.deepEqual(monthlyUsageWindow("2024-02"), {
    since: "2024-02-01T00:00:00.000Z",
    until: "2024-03-01T00:00:00.000Z",
  });
  for (const month of ["1999-12", "9999-12", "2026-00", "2026-13", "../x"]) {
    assert.throws(() => monthlyUsageWindow(month), /YYYY-MM/);
  }
  await updateSettings({
    requireLogin: true,
    password: await hashManagementPassword("Monthly reports private 42!"),
  });
  assert.equal(
    (await route.GET(new Request("http://localhost/api/usage/monthly-report"))).status,
    401
  );
  const token = await mintDashboardSessionToken(getDashboardJwtSecret()!);
  const request = (query: string) =>
    new Request(`http://localhost/api/usage/monthly-report?${query}`, {
      headers: { cookie: `${DASHBOARD_SESSION_COOKIE}=${token}` },
    });
  assert.equal((await route.GET(request("month=2026-09"))).status, 200);
  const estimates = await analyticsRoute.GET(
    new Request("http://localhost/api/usage/analytics?range=all", {
      headers: { cookie: `${DASHBOARD_SESSION_COOKIE}=${token}` },
    })
  );
  assert.equal(estimates.status, 200);
  const estimateBody = await estimates.json();
  assert.equal(estimateBody.costBasis, "current_price_estimates_and_stored_summaries");
  assert.equal(estimateBody.costWindow.timezone, "UTC");
  for (const query of [
    "month=../x",
    "month=2026-09&apiKeyId=",
    `month=2026-09&${Array.from({ length: 501 }, () => "apiKeyId=k").join("&")}`,
  ]) {
    const response = await route.GET(request(query));
    assert.equal(response.status, 400);
    assert.doesNotMatch(await response.text(), /at \/|SELECT|\.ts:\d/);
  }
  const missing = await route.GET(request("month=2026-09&tenantId=missing"));
  assert.equal(missing.status, 404);
  assert.doesNotMatch(await missing.text(), /at \/|SELECT|\.ts:\d/);
  const sql = getDbInstance()
    .prepare("SELECT COUNT(*) AS count FROM request_cost_ledger")
    .get() as { count: number };
  assert.ok(sql.count > 0);
});
