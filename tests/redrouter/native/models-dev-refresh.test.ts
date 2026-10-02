import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
const directory = mkdtempSync(join(tmpdir(), "rr-models-dev-refresh-"));
process.env.DATA_DIR = directory;
const { getDbInstance, resetDbInstance } = await import("../../../src/lib/db/core.ts");
const sync = await import("../../../src/lib/modelsDevSync.ts");
const { readModelsDevSnapshotData, commitModelsDevSnapshot } =
  await import("../../../src/lib/db/modelsDevSnapshot.ts");
const { invalidateDbCache } = await import("../../../src/lib/db/readCache.ts");
const { getPricingForModel, updatePricing } =
  await import("../../../src/lib/db/settings/pricing.ts");
const nativeFetch = globalThis.fetch;
const previousSyncFlag = process.env.MODELS_DEV_SYNC_ENABLED;
delete process.env.MODELS_DEV_SYNC_ENABLED;
let generation = 0;
const fixture = () => ({
  openai: {
    id: "openai",
    models: {
      fixture: {
        id: "fixture",
        name: "Fixture",
        cost: { input: generation + 1, output: 2 },
        reasoning: true,
        tool_call: true,
      },
    },
  },
});
after(() => {
  globalThis.fetch = nativeFetch;
  sync.stopPeriodicSync();
  if (previousSyncFlag === undefined) delete process.env.MODELS_DEV_SYNC_ENABLED;
  else process.env.MODELS_DEV_SYNC_ENABLED = previousSyncFlag;
  resetDbInstance();
  rmSync(directory, { recursive: true, force: true });
});

test("cache reads reuse a snapshot; manual force fetches fresh data and caller cancellation remains bounded", async () => {
  let requests = 0;
  globalThis.fetch = async (_input, options) => {
    requests++;
    assert.ok(options?.signal);
    return Response.json(fixture());
  };
  const signal = new AbortController().signal;
  await sync.fetchModelsDev(signal);
  await sync.fetchModelsDev(signal);
  assert.equal(requests, 1);
  generation++;
  const fresh = await sync.fetchModelsDev(signal, { force: true });
  assert.equal(requests, 2);
  assert.equal(fresh.openai.models.fixture.cost!.input, 2);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(sync.fetchModelsDev(controller.signal));
  globalThis.fetch = async (_input, options) =>
    new Promise((_resolve, reject) =>
      options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), {
        once: true,
      })
    );
  const keepAlive = setTimeout(() => {}, 100);
  try {
    await assert.rejects(sync.fetchModelsDev(signal, { force: true, timeoutMs: 5 }));
  } finally {
    clearTimeout(keepAlive);
  }
});

test("snapshot writes are atomic, preserve live discovery and leave user pricing in control", async () => {
  globalThis.fetch = async () => Response.json(fixture());
  await updatePricing({ openai: { fixture: { input: 99, output: 100 } } });
  assert.equal((await sync.syncModelsDev({ force: true, maxRetries: 0 })).success, true);
  assert.equal((await getPricingForModel("openai", "fixture"))?.input, 99);
  const cap = sync.getSyncedCapability("openai", "fixture")!;
  sync.upsertSyncedCapabilities("openai", {
    fixture: { ...cap, reasoning: false },
    "live-only": cap,
  });
  const db = getDbInstance();
  const oldPricing = sync.getModelsDevPricing().openai.fixture.input;
  const oldSnapshot = sync.getSyncStatus().snapshot;
  const oldPublicData = readModelsDevSnapshotData();
  db.exec(
    "CREATE TRIGGER fail_cap_snapshot BEFORE INSERT ON model_capabilities BEGIN SELECT RAISE(ABORT, 'fixture failure'); END"
  );
  generation++;
  assert.equal((await sync.syncModelsDev({ force: true, maxRetries: 0 })).success, false);
  assert.equal(sync.getModelsDevPricing().openai.fixture.input, oldPricing);
  assert.deepEqual(sync.getSyncStatus().snapshot, oldSnapshot);
  assert.deepEqual(readModelsDevSnapshotData(), oldPublicData);
  db.exec("DROP TRIGGER fail_cap_snapshot");
  assert.equal((await sync.syncModelsDev({ force: true, maxRetries: 0 })).success, true);
  assert.equal(sync.getSyncedCapability("openai", "fixture")?.reasoning, false);
  assert.ok(sync.getSyncedCapability("openai", "live-only"));
  assert.notEqual(sync.getSyncStatus().snapshot?.sha256, oldSnapshot?.sha256);
});

test("typed public metadata and validators persist without importing provider execution configuration", async () => {
  generation++;
  const payload = {
    ...fixture(),
    openrouter: {
      id: "openrouter",
      api: "https://untrusted.invalid/runtime",
      env: ["UPSTREAM_KEY"],
      credentials: "must-not-be-cached",
      models: {
        "canonical-catalog-key": {
          id: "~typesafe/jev-latest",
          name: "JEV",
          type: "decision",
          canonical_model_id: "typesafe/jev-latest",
          reasoning: false,
          tool_call: false,
          reasoning_options: [{ type: "effort", values: [null, "low", "high", "max"] }],
          cost: { input: 0.042, output: 0 },
          provider: { body: { credential: "must-not-be-cached" }, api: "https://invalid.test" },
          headers: { Authorization: "must-not-be-cached" },
        },
      },
    },
  };
  const db = getDbInstance();
  const connectionsBefore = db.prepare("SELECT COUNT(*) AS count FROM provider_connections").get();
  const selectionsBefore = db
    .prepare(
      "SELECT * FROM key_value WHERE namespace IN ('customModels', 'modelCompatOverrides', 'pricing') ORDER BY namespace, key"
    )
    .all();
  globalThis.fetch = async (input) => {
    assert.equal(String(input), "https://models.dev/api.json?type=all");
    return Response.json(payload, {
      headers: { ETag: '"typed-v1"', "Last-Modified": "Fri, 02 Oct 2026 12:00:00 GMT" },
    });
  };
  assert.equal((await sync.syncModelsDev({ force: true, maxRetries: 0 })).success, true);
  const capability = sync.getSyncedCapability("openrouter", "~typesafe/jev-latest")!;
  assert.equal(capability.model_type, "decision");
  assert.equal(capability.canonical_model_id, "typesafe/jev-latest");
  assert.equal(capability.native_model_id, "~typesafe/jev-latest");
  assert.equal(capability.source_provider, "openrouter");
  assert.equal(capability.metadata_source, "models-dev");
  assert.deepEqual(
    JSON.parse(capability.reasoning_options!),
    payload.openrouter.models["canonical-catalog-key"].reasoning_options
  );
  const persisted = JSON.stringify(readModelsDevSnapshotData());
  assert.ok(!persisted.includes("must-not-be-cached"));
  assert.ok(!persisted.includes("untrusted.invalid"));
  assert.ok(!persisted.includes("UPSTREAM_KEY"));
  assert.equal(sync.getSyncStatus().snapshot?.etag, '"typed-v1"');
  assert.deepEqual(
    db.prepare("SELECT COUNT(*) AS count FROM provider_connections").get(),
    connectionsBefore
  );
  assert.deepEqual(
    db
      .prepare(
        "SELECT * FROM key_value WHERE namespace IN ('customModels', 'modelCompatOverrides', 'pricing') ORDER BY namespace, key"
      )
      .all(),
    selectionsBefore
  );
});

test("304 uses the committed public snapshot after process restart and never rewrites capability rows", () => {
  const source = new URL("../../../src/lib/modelsDevSync.ts", import.meta.url).href;
  const snapshotBefore = sync.getSyncStatus().snapshot!;
  const db = getDbInstance();
  db.exec(
    "CREATE TRIGGER no_304_rewrite BEFORE INSERT ON model_capabilities BEGIN SELECT RAISE(ABORT, '304 rewrote capabilities'); END"
  );
  const script = `
    import assert from "node:assert/strict";
    const sync = await import(${JSON.stringify(source)});
    const before = sync.getSyncStatus();
    assert.equal(before.snapshot.etag, '"typed-v1"');
    assert.ok(before.lastSyncModelCount > 0);
    globalThis.fetch = async (input, options) => {
      assert.equal(String(input), "https://models.dev/api.json?type=all");
      const headers = new Headers(options.headers);
      assert.equal(headers.get("If-None-Match"), '"typed-v1"');
      assert.equal(headers.get("If-Modified-Since"), "Fri, 02 Oct 2026 12:00:00 GMT");
      return new Response(null, { status: 304 });
    };
    const refreshed = await sync.syncModelsDev({ force: true, maxRetries: 0 });
    assert.equal(refreshed.success, true);
    assert.equal(refreshed.modelCount, before.lastSyncModelCount);
    assert.equal(sync.getSyncStatus().snapshot.sha256, before.snapshot.sha256);
    assert.equal(sync.getSyncStatus().snapshot.savedAt, before.snapshot.savedAt);
    assert.equal(sync.getSyncedCapability("openrouter", "~typesafe/jev-latest").model_type, "decision");
  `;
  try {
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx/esm", "--input-type=module", "--eval", script],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATA_DIR: directory },
        encoding: "utf8",
        timeout: 20000,
      }
    );
    assert.equal(child.status, 0, child.stderr || child.stdout);
    assert.equal(sync.getSyncStatus().snapshot?.sha256, snapshotBefore.sha256);
    assert.equal(sync.getSyncStatus().snapshot?.savedAt, snapshotBefore.savedAt);
    assert.ok(sync.getSyncStatus().lastCheck);
  } finally {
    db.exec("DROP TRIGGER no_304_rewrite");
  }
});

test("manual callers coalesce and one cancelled subscriber does not abort the remaining refresh", async () => {
  generation++;
  let requests = 0;
  let release: (response: Response) => void;
  let transportSignal: AbortSignal;
  globalThis.fetch = async (_input, options) => {
    requests++;
    transportSignal = options!.signal!;
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  };
  const cancelled = new AbortController();
  const first = sync.syncModelsDev({ force: true, maxRetries: 0, signal: cancelled.signal });
  const second = sync.syncModelsDev({ force: true, maxRetries: 0 });
  cancelled.abort();
  assert.equal((await first).error, "aborted");
  assert.equal(requests, 1);
  assert.equal(transportSignal!.aborted, false);
  release!(Response.json(fixture()));
  assert.equal((await second).success, true);
});

test("stopping periodic sync keeps an attached manual refresh alive", async () => {
  generation++;
  let requests = 0;
  let release: (response: Response) => void;
  let transportSignal: AbortSignal;
  globalThis.fetch = async (_input, options) => {
    requests++;
    transportSignal = options!.signal!;
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  };
  sync.startPeriodicSync(60000);
  const manual = sync.syncModelsDev({ force: true });
  sync.stopPeriodicSync();
  assert.equal(requests, 1);
  assert.equal(transportSignal!.aborted, false);
  release!(Response.json(fixture()));
  assert.equal((await manual).success, true);
  assert.equal(sync.getSyncStatus().enabled, false);
});

test("the hard env kill switch prevents periodic network traffic", () => {
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return Response.json(fixture());
  };
  process.env.MODELS_DEV_SYNC_ENABLED = "0";
  try {
    sync.startPeriodicSync(60000);
    assert.equal(sync.getSyncStatus().enabled, false);
    assert.equal(requests, 0);
  } finally {
    delete process.env.MODELS_DEV_SYNC_ENABLED;
  }
});

test("invalid refresh retains the last usable snapshot and never reports success", async () => {
  const old = sync.getSyncStatus().snapshot;
  globalThis.fetch = async () => Response.json({ error: "remote fixture" });
  assert.equal((await sync.syncModelsDev({ force: true, maxRetries: 0 })).success, false);
  assert.deepEqual(sync.getSyncStatus().snapshot, old);
  const invalid = fixture();
  invalid.openai.models.fixture.cost.input = -1;
  globalThis.fetch = async () => Response.json(invalid);
  assert.equal((await sync.syncModelsDev({ force: true, maxRetries: 0 })).success, false);
  assert.deepEqual(sync.getSyncStatus().snapshot, old);
});

test("obsolete owned overlays are quarantined while opt-out retains user and discovery data", async () => {
  const db = getDbInstance();
  const capability = sync.getSyncedCapability("openai", "fixture")!;
  const discoveryBefore = sync.getSyncedCapability("openai", "fixture");
  sync.upsertSyncedCapabilities("manual", { owned: capability });
  db.prepare(
    "UPDATE model_capabilities SET capability_source = 'user' WHERE provider = 'manual'"
  ).run();
  sync.saveModelsDevCapabilities({ cx: { "obsolete-only": capability } });
  sync.saveModelsDevPricing({ cx: { "obsolete-only": { input: 0, output: 0 } } });
  const metadata = sync.getSyncStatus().snapshot!;
  commitModelsDevSnapshot({ ...metadata, transformVersion: 1 }, () => {});
  invalidateDbCache("pricing");
  assert.deepEqual(sync.getModelsDevPricing(), {});
  assert.equal(sync.getSyncedCapability("cx", "obsolete-only"), null);
  assert.equal(sync.loadAllSyncedCapabilitiesUncached().cx, undefined);
  assert.equal(
    sync.getSyncedCapability("openai", "fixture")?.reasoning,
    discoveryBefore?.reasoning
  );
  assert.equal(sync.getSyncedCapability("manual", "owned")?.metadata_source, "user");
  assert.equal((await getPricingForModel("openai", "fixture"))?.input, 99);
  assert.ok(
    db
      .prepare("SELECT value FROM key_value WHERE namespace = 'models_dev_pricing' AND key = 'cx'")
      .get()
  );
  assert.ok(
    db
      .prepare(
        "SELECT model_id FROM model_capabilities WHERE provider = 'cx' AND model_id = 'obsolete-only'"
      )
      .get()
  );
  assert.equal(sync.getSyncStatus().enabled, false);
  generation++;
  globalThis.fetch = async () => Response.json(fixture());
  assert.equal(
    (await sync.syncModelsDev({ force: true, maxRetries: 0, syncCapabilities: false })).success,
    true
  );
  assert.equal(sync.getSyncStatus().snapshot?.transformVersion, 2);
  assert.equal(sync.getSyncStatus().snapshot?.capabilitiesSynced, false);
  assert.equal(sync.getSyncedCapability("cx", "obsolete-only"), null);
  assert.equal(sync.getSyncedCapabilities().cx, undefined);
  assert.equal(sync.loadAllSyncedCapabilitiesUncached().cx, undefined);
  assert.ok(
    db
      .prepare(
        "SELECT model_id FROM model_capabilities WHERE provider = 'cx' AND model_id = 'obsolete-only'"
      )
      .get()
  );
  assert.equal(sync.getSyncedCapability("openai", "fixture")?.metadata_source, "discovery");
  assert.equal(sync.getSyncedCapability("manual", "owned")?.metadata_source, "user");
  assert.equal((await sync.syncModelsDev({ force: true, maxRetries: 0 })).success, true);
  assert.equal(sync.getSyncStatus().snapshot?.transformVersion, 2);
  assert.equal(sync.getModelsDevPricing().cx, undefined);
  assert.ok(sync.getModelsDevPricing().openai.fixture.input > 0);
  assert.equal(sync.getSyncedCapability("openai", "fixture")?.metadata_source, "discovery");
  assert.equal(sync.getSyncedCapability("manual", "owned")?.metadata_source, "user");
});
