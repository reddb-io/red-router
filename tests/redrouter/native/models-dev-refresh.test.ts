import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
const directory = mkdtempSync(join(tmpdir(), "rr-models-dev-refresh-"));
process.env.DATA_DIR = directory;
const { getDbInstance, resetDbInstance } = await import("../../../src/lib/db/core.ts");
const sync = await import("../../../src/lib/modelsDevSync.ts");
const { getPricingForModel, updatePricing } =
  await import("../../../src/lib/db/settings/pricing.ts");
const nativeFetch = globalThis.fetch;
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
  db.exec(
    "CREATE TRIGGER fail_cap_snapshot BEFORE INSERT ON model_capabilities BEGIN SELECT RAISE(ABORT, 'fixture failure'); END"
  );
  generation++;
  assert.equal((await sync.syncModelsDev({ force: true, maxRetries: 0 })).success, false);
  assert.equal(sync.getModelsDevPricing().openai.fixture.input, oldPricing);
  assert.deepEqual(sync.getSyncStatus().snapshot, oldSnapshot);
  db.exec("DROP TRIGGER fail_cap_snapshot");
  assert.equal((await sync.syncModelsDev({ force: true, maxRetries: 0 })).success, true);
  assert.equal(sync.getSyncedCapability("openai", "fixture")?.reasoning, false);
  assert.ok(sync.getSyncedCapability("openai", "live-only"));
  assert.notEqual(sync.getSyncStatus().snapshot?.sha256, oldSnapshot?.sha256);
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
