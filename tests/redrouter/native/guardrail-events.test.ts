import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "redrouter-guardrail-events-"));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = "test-jwt-secret-for-guardrail-events";
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "guardrail-events-test-secret";

const { getDbInstance, resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { updateSettings } = await import("../../../src/lib/db/settings.ts");
const { hashManagementPassword } = await import("../../../src/lib/auth/managementPassword.ts");
const { DASHBOARD_SESSION_COOKIE, getDashboardJwtSecret, mintDashboardSessionToken } = await import(
  "../../../src/shared/utils/dashboardSessionToken.ts"
);
const repo = await import("../../../src/lib/db/guardrailEvents.ts");
const runtime = await import("../../../src/lib/guardrails/runtime.ts");
const { GuardrailRegistry } = await import("../../../src/lib/guardrails/registry.ts");
const { ContentFilterGuardrail } = await import("../../../src/lib/guardrails/contentFilter.ts");
const { PIIMaskerGuardrail } = await import("../../../src/lib/guardrails/piiMasker.ts");
const route = await import("../../../src/app/api/guardrails/events/route.ts");

after(() => {
  resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const settle = () => new Promise((resolve) => setImmediate(resolve));

async function get(query = "", authenticated = true) {
  const token = await mintDashboardSessionToken(getDashboardJwtSecret());
  return route.GET(
    new (await import("next/server")).NextRequest(`http://localhost/api/guardrails/events${query}`, {
      headers: authenticated ? { cookie: `${DASHBOARD_SESSION_COOKIE}=${token}` } : {},
    })
  );
}

test("migration 204 creates the events table with its indexes", () => {
  const db = getDbInstance();
  const columns = (db.prepare("PRAGMA table_info(guardrail_events)").all() as Array<{ name: string }>).map(
    (column) => column.name
  );
  assert.deepEqual(columns, [
    "id",
    "ts",
    "guardrail_id",
    "stage",
    "action",
    "api_key_id",
    "request_id",
    "rule_id",
  ]);
  const indexes = (db.prepare("PRAGMA index_list(guardrail_events)").all() as Array<{ name: string }>).map(
    (index) => index.name
  );
  assert.ok(indexes.includes("idx_guardrail_events_ts"));
  assert.ok(indexes.includes("idx_guardrail_events_guardrail_ts"));
  assert.throws(() =>
    db
      .prepare("INSERT INTO guardrail_events (ts, guardrail_id, stage, action) VALUES (1, 'x', 'request', 'delete')")
      .run()
  );
});

test("every handler refuses a caller without a management session", async () => {
  await updateSettings({
    requireLogin: true,
    password: await hashManagementPassword("correct horse battery staple 42"),
  });
  assert.equal((await get("", false)).status, 401);
  assert.equal((await get("", true)).status, 200, "a management session gets through");
});

test("recording never throws, even when the table is unusable", () => {
  const db = getDbInstance();
  assert.equal(repo.recordGuardrailEvent({ guardrailId: "x", stage: "request", action: "block" }), true);
  db.exec("ALTER TABLE guardrail_events RENAME TO guardrail_events_away");
  try {
    assert.equal(repo.recordGuardrailEvent({ guardrailId: "x", stage: "request", action: "block" }), false);
  } finally {
    db.exec("ALTER TABLE guardrail_events_away RENAME TO guardrail_events");
  }
  db.exec("DELETE FROM guardrail_events");
});

test("a blocked request is recorded with its key, request id and rule id, and no content", async () => {
  const registry = new GuardrailRegistry();
  registry.register(new ContentFilterGuardrail());
  await registry.runPreCallHooks(
    { messages: [{ role: "user", content: "the passphrase is swordfish" }] },
    {
      guardrailPlan: {
        entries: {},
        contentFilter: {
          enabled: true,
          rules: [{ id: "r-fish", label: "fish", type: "keyword", pattern: "swordfish", scope: "both", action: "block", enabled: true }],
        },
      },
      recordEvent: runtime.createGuardrailEventRecorder({ apiKeyInfo: { id: "key-7" }, requestId: "req-1" }),
    }
  );
  await settle();

  const [event] = repo.listGuardrailEvents({ guardrail: "content-filter" });
  assert.equal(event.action, "block");
  assert.equal(event.stage, "request");
  assert.equal(event.apiKeyId, "key-7");
  assert.equal(event.requestId, "req-1");
  assert.equal(event.ruleId, "r-fish");
  assert.ok(!JSON.stringify(event).includes("swordfish"));
  const raw = JSON.stringify(getDbInstance().prepare("SELECT * FROM guardrail_events").all());
  assert.ok(!raw.includes("swordfish") && !raw.includes("passphrase"), "nothing but ids reaches the table");
});

test("a masking guardrail that changed the payload is recorded as a mask event", async () => {
  process.env.PII_REDACTION_ENABLED = "true";
  try {
    const registry = new GuardrailRegistry();
    registry.register(new PIIMaskerGuardrail());
    const out = await registry.runPreCallHooks(
      { messages: [{ role: "user", content: "mail me at jane.doe@example.com" }] },
      { recordEvent: runtime.createGuardrailEventRecorder({ apiKeyInfo: null, requestId: "req-2" }) }
    );
    await settle();
    assert.ok(out.results.some((r) => r.guardrail === "pii-masker" && r.modified), "the masker acted");
    const events = repo.listGuardrailEvents({ guardrail: "pii-masker" });
    assert.equal(events[0]?.action, "mask");
    assert.equal(events[0]?.apiKeyId, null);
  } finally {
    delete process.env.PII_REDACTION_ENABLED;
  }
});

test("listing filters by guardrail and time, newest first, and validates its query", async () => {
  getDbInstance().exec("DELETE FROM guardrail_events");
  const now = Date.now();
  repo.resetGuardrailEventPruneClock();
  repo.recordGuardrailEvent({ guardrailId: "content-filter", stage: "request", action: "block", ruleId: "a", ts: now - 3 * HOUR });
  repo.recordGuardrailEvent({ guardrailId: "content-filter", stage: "response", action: "flag", ruleId: "b", ts: now - 2 * HOUR });
  repo.recordGuardrailEvent({ guardrailId: "pii-masker", stage: "request", action: "mask", ts: now - HOUR });
  repo.recordGuardrailEvent({ guardrailId: "content-filter", stage: "request", action: "block", ruleId: "a", ts: now - 26 * HOUR });

  const all = await (await get("?limit=50")).json();
  assert.deepEqual(all.events.map((event: { ts: number }) => event.ts), [...all.events.map((e: { ts: number }) => e.ts)].sort((x, y) => y - x));
  assert.equal(all.events.length, 4);

  const filtered = await (await get("?guardrail=content-filter")).json();
  assert.equal(filtered.events.length, 3);
  assert.ok(filtered.events.every((event: { guardrailId: string }) => event.guardrailId === "content-filter"));

  const sinceMs = await (await get(`?since=${now - 150 * 60 * 1000}`)).json();
  assert.equal(sinceMs.events.length, 2);
  const sinceIso = await (await get(`?since=${encodeURIComponent(new Date(now - 150 * 60 * 1000).toISOString())}`)).json();
  assert.equal(sinceIso.events.length, 2);

  assert.equal((await (await get("?limit=1")).json()).events.length, 1);

  for (const bad of ["?limit=0", "?limit=501", "?limit=abc", "?since=yesterday", "?since=-5", "?guardrail=Bad%20Name", `?guardrail=${"x".repeat(65)}`]) {
    const response = await get(bad);
    assert.equal(response.status, 400, bad);
    assert.equal((await response.json()).error.message, "Invalid query parameters");
  }
});

test("the summary counts the last 24 hours per guardrail and action", async () => {
  const body = await (await get()).json();
  assert.equal(body.retentionDays, 30);
  assert.deepEqual(body.counts24h, [
    { guardrailId: "content-filter", block: 1, flag: 1, mask: 0, total: 2 },
    { guardrailId: "pii-masker", block: 0, flag: 0, mask: 1, total: 1 },
  ]);
  assert.deepEqual(repo.countGuardrailEvents(Date.now() - 2 * DAY).find((row) => row.guardrailId === "content-filter")?.block, 2);
});

test("events past 30 days are pruned by the writer, and at most once an hour", () => {
  const db = getDbInstance();
  db.exec("DELETE FROM guardrail_events");
  const now = Date.now();
  repo.resetGuardrailEventPruneClock();
  repo.recordGuardrailEvent({ guardrailId: "g", stage: "request", action: "flag", ts: now }); // spends this hour's prune
  repo.recordGuardrailEvent({ guardrailId: "g", stage: "request", action: "flag", ts: now - 31 * DAY });
  repo.recordGuardrailEvent({ guardrailId: "g", stage: "request", action: "flag", ts: now - 29 * DAY });
  const count = () => (db.prepare("SELECT COUNT(*) AS n FROM guardrail_events").get() as { n: number }).n;
  assert.equal(count(), 3, "no second prune inside the hour");

  repo.resetGuardrailEventPruneClock();
  repo.recordGuardrailEvent({ guardrailId: "g", stage: "request", action: "flag", ts: now });
  assert.equal(count(), 3, "the 31 day old row went, the new one arrived");
  assert.equal(repo.listGuardrailEvents({ since: now - 30 * DAY }).length, 3);
  assert.equal(repo.pruneGuardrailEvents(now + 2 * DAY), 1, "a later clock prunes the 29 day old row");
});
