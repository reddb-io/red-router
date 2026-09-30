import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "redrouter-guardrail-assignment-"));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = "test-jwt-secret-for-guardrail-assignment";

const { resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { updateSettings } = await import("../../../src/lib/db/settings.ts");
const { createKeyGroup, addKeyToGroup } = await import("../../../src/lib/db/apiKeyGroups.ts");
const { getDbInstance } = await import("../../../src/lib/db/core.ts");
const assignment = await import("../../../src/lib/guardrails/assignment.ts");
const { GUARDRAIL_CATALOG } = await import("../../../src/lib/guardrails/catalog.ts");
const runtime = await import("../../../src/lib/guardrails/runtime.ts");
const registryModule = await import("../../../src/lib/guardrails/registry.ts");
const { GuardrailRegistry } = registryModule;
const { BaseGuardrail } = await import("../../../src/lib/guardrails/base.ts");
const { updateSettingsSchema } = await import("../../../src/shared/validation/settingsSchemas.ts");

after(() => {
  resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => runtime.resetGuardrailRuntimeCache());

const A = (over: Partial<import("../../../src/lib/guardrails/assignment.ts").GuardrailAssignments>) => ({
  ...assignment.emptyGuardrailAssignments(),
  ...over,
});
const state = (list: ReturnType<typeof assignment.resolveGuardrails>, id: string) =>
  list.find((item) => item.id === id)!;

test("the catalog names every built-in guardrail the registry registers", () => {
  const registered = registryModule.guardrailRegistry.list().map((g) => g.name).sort();
  assert.deepEqual(GUARDRAIL_CATALOG.map((entry) => entry.id).sort(), registered);
  for (const entry of registryModule.guardrailRegistry.list()) {
    const catalog = GUARDRAIL_CATALOG.find((item) => item.id === entry.name)!;
    assert.equal(catalog.defaultPriority, entry.priority, `${entry.name} default priority`);
  }
});

test("with no assignments every guardrail sits at its catalog priority, mutators are off", () => {
  const list = assignment.resolveGuardrails({});
  assert.deepEqual(
    list.map((item) => item.id),
    [...GUARDRAIL_CATALOG].sort((a, b) => a.defaultPriority - b.defaultPriority).map((item) => item.id)
  );
  for (const item of list) {
    assert.equal(item.source, "default");
    assert.equal(item.enabled, !item.mutatesData, `${item.id}: only non-mutating guardrails default on`);
  }
});

test("global entries set state and priority; the list is ordered by priority then id", () => {
  const list = assignment.resolveGuardrails({
    assignments: A({
      global: [
        { id: "prompt-injection", enabled: false, priority: 500 },
        { id: "content-filter", enabled: true, priority: 1 },
        { id: "pii-masker", enabled: true, priority: 1 },
      ],
    }),
  });
  assert.deepEqual(list.slice(0, 2).map((item) => item.id), ["content-filter", "pii-masker"], "tie on priority 1 breaks by id");
  assert.equal(list.at(-1)?.id, "prompt-injection");
  assert.equal(state(list, "prompt-injection").enabled, false);
  assert.equal(state(list, "pii-masker").enabled, true);
});

test("group overrides beat global, key overrides beat groups, and disabled beats enabled in one scope", () => {
  const assignments = A({
    global: [{ id: "prompt-injection", enabled: true, priority: 20 }],
    byGroup: {
      g1: { disabled: ["prompt-injection"], enabled: [] },
      g2: { disabled: [], enabled: ["prompt-injection"] },
      conflicted: { disabled: ["content-filter"], enabled: ["content-filter"] },
    },
    byKey: { k1: { disabled: [], enabled: ["prompt-injection"] }, k2: { disabled: ["prompt-injection"], enabled: [] } },
  });
  const at = (keyId: string | null, groupIds: string[], id = "prompt-injection") =>
    state(assignment.resolveGuardrails({ keyId, groupIds, assignments }), id);

  assert.equal(at(null, []).enabled, true, "global default");
  assert.equal(at("other", ["g1"]).enabled, false, "group disables");
  assert.equal(at("other", ["g1"]).source, "group");
  assert.equal(at("other", ["g1", "g2"]).enabled, true, "a later group wins");
  assert.equal(at("k1", ["g1"]).enabled, true, "the key wins over its group");
  assert.equal(at("k1", ["g1"]).source, "key");
  assert.equal(at("k2", ["g2"]).enabled, false, "the key can disable too");
  assert.equal(at(null, ["conflicted"], "content-filter").enabled, false, "disabled beats enabled");
  assert.equal(at("ghost", ["missing-group"]).enabled, true, "unknown scopes change nothing");
});

test("a mutating guardrail is never enabled implicitly, only by an explicit enabled entry", () => {
  const ids = GUARDRAIL_CATALOG.filter((entry) => entry.mutatesData).map((entry) => entry.id);
  assert.ok(ids.includes("pii-masker") && ids.includes("credential-masker"));

  // Mentioning a mutator only to set its priority does not switch it on.
  const priorityOnly = assignment.resolveGuardrails({
    assignments: A({ global: [{ id: "pii-masker", enabled: false, priority: 3 }] }),
  });
  assert.equal(state(priorityOnly, "pii-masker").enabled, false);
  assert.equal(state(priorityOnly, "pii-masker").priority, 3);

  // Unrelated assignments leave it off.
  const unrelated = assignment.resolveGuardrails({
    assignments: A({ global: [{ id: "prompt-injection", enabled: true, priority: 20 }] }),
  });
  for (const id of ids) assert.equal(state(unrelated, id).enabled, false, id);

  // Explicit enablement, at any scope, counts.
  const viaGlobal = assignment.resolveGuardrails({
    assignments: A({ global: [{ id: "pii-masker", enabled: true, priority: 10 }] }),
  });
  assert.equal(state(viaGlobal, "pii-masker").enabled, true);
  const viaKey = assignment.resolveGuardrails({
    keyId: "k",
    assignments: A({ byKey: { k: { disabled: [], enabled: ["credential-masker"] } } }),
  });
  assert.equal(state(viaKey, "credential-masker").enabled, true);
  assert.equal(state(viaKey, "pii-masker").enabled, false);

  // A broader explicit enable does not survive a narrower disable.
  const revoked = assignment.resolveGuardrails({
    keyId: "k",
    assignments: A({
      global: [{ id: "pii-masker", enabled: true, priority: 10 }],
      byKey: { k: { disabled: ["pii-masker"], enabled: [] } },
    }),
  });
  assert.equal(state(revoked, "pii-masker").enabled, false);
});

test("stored assignments are read defensively", () => {
  const messy = assignment.normalizeGuardrailAssignments({
    global: [
      { id: "prompt-injection", enabled: 1, priority: "x" },
      { id: "prompt-injection", enabled: true, priority: 5 },
      { enabled: true },
      null,
    ],
    byKey: { k: { disabled: ["a", 3, ""], enabled: "nope" }, __proto__: { x: 1 }, "": { disabled: [], enabled: [] } },
    byGroup: [],
  });
  assert.deepEqual(messy.global, [{ id: "prompt-injection", enabled: false, priority: 20 }]);
  assert.deepEqual(messy.byKey, { k: { disabled: ["a"], enabled: [] } });
  assert.deepEqual(messy.byGroup, {});
  assert.deepEqual(assignment.normalizeGuardrailAssignments("garbage"), assignment.emptyGuardrailAssignments());
  assert.doesNotThrow(() => assignment.resolveGuardrails({ keyId: "__proto__", groupIds: ["constructor"], assignments: messy }));
});

test("the assignments setting is validated", () => {
  const ok = { global: [{ id: "pii-masker", enabled: true, priority: 10 }], byKey: { k: { disabled: [], enabled: ["pii-masker"] } }, byGroup: {} };
  assert.equal(updateSettingsSchema.safeParse({ guardrailAssignments: ok }).success, true);
  const bad: unknown[] = [
    { ...ok, global: [{ id: "nope", enabled: true, priority: 1 }] },
    { ...ok, global: [{ id: "pii-masker", enabled: true, priority: -1 }] },
    { ...ok, global: [{ id: "pii-masker", enabled: true, priority: 1001 }] },
    { ...ok, global: [{ id: "pii-masker", enabled: true, priority: 1.5 }] },
    { ...ok, global: [{ id: "pii-masker", enabled: true, priority: 1 }, { id: "pii-masker", enabled: false, priority: 2 }] },
    { ...ok, byKey: { k: { disabled: ["nope"], enabled: [] } } },
    { ...ok, byKey: { k: { disabled: [] } } },
    { ...ok, byGroup: { "": { disabled: [], enabled: [] } } },
    { global: [] },
  ];
  for (const value of bad) {
    assert.equal(updateSettingsSchema.safeParse({ guardrailAssignments: value }).success, false, JSON.stringify(value).slice(0, 90));
  }
});

// --- Plan building and wiring ---------------------------------------------------------------

const off = { assignments: assignment.emptyGuardrailAssignments(), contentFilter: { enabled: false, rules: [] } };

test("nothing configured yields no plan at all", () => {
  assert.equal(runtime.buildGuardrailPlan(off, { keyId: "k" }), null);
});

test("the plan carries resolved entries, and the filter needs its own switch and the assignments", () => {
  const filter = { enabled: true, rules: [{ id: "r", label: "", type: "keyword" as const, pattern: "x", scope: "both" as const, action: "block" as const, enabled: true }] };
  const onlyFilter = runtime.buildGuardrailPlan({ ...off, contentFilter: filter }, {});
  assert.deepEqual(onlyFilter?.entries, {});
  assert.equal(onlyFilter?.contentFilter, filter);

  const disabledForKey = runtime.buildGuardrailPlan(
    { assignments: A({ byKey: { k: { disabled: ["content-filter"], enabled: [] } } }), contentFilter: filter },
    { keyId: "k" }
  );
  assert.equal(disabledForKey?.contentFilter, null, "a key can opt out of the operator's filter");
  assert.equal(disabledForKey?.entries["content-filter"]?.enabled, false);
  const otherKey = runtime.buildGuardrailPlan(
    { assignments: A({ byKey: { k: { disabled: ["content-filter"], enabled: [] } } }), contentFilter: filter },
    { keyId: "other" }
  );
  assert.equal(otherKey?.contentFilter, filter);
});

test("without a plan the registry runs exactly as before: same guardrails, same order, same results", async () => {
  const registry = registryModule.guardrailRegistry;
  const payload = { model: "m", messages: [{ role: "user", content: "hello there" }] };
  const legacy = await registry.runPreCallHooks(payload, {});
  const withNullPlan = await registry.runPreCallHooks(payload, { guardrailPlan: null });
  const withEmptyPlan = await registry.runPreCallHooks(payload, {
    guardrailPlan: { entries: {}, contentFilter: null },
  });
  assert.deepEqual(legacy.results.map((r) => r.guardrail), [
    "vision-bridge",
    "audio-bridge",
    "video-bridge",
    "pii-masker",
    "prompt-injection",
    "credential-masker",
  ]);
  assert.deepEqual(withNullPlan, legacy);
  assert.deepEqual(withEmptyPlan, legacy);
  assert.deepEqual(legacy.payload, payload);

  const reply = { choices: [{ message: { role: "assistant", content: "hi" } }] };
  const post = await registry.runPostCallHooks(reply, {});
  assert.deepEqual(await registry.runPostCallHooks(reply, { guardrailPlan: null }), post);
  assert.ok(!post.results.some((r) => r.guardrail === "content-filter"));
});

class Recorder extends BaseGuardrail {
  log: string[];
  constructor(name: string, priority: number, log: string[]) {
    super(name, { priority });
    this.log = log;
  }
  async preCall() {
    this.log.push(this.name);
  }
}

test("a plan reorders and disables guardrails for the request it was built for", async () => {
  const log: string[] = [];
  const registry = new GuardrailRegistry();
  registry.register(new Recorder("pii-masker", 10, log));
  registry.register(new Recorder("prompt-injection", 20, log));
  registry.register(new Recorder("custom-extra", 30, log));

  await registry.runPreCallHooks({}, {});
  assert.deepEqual(log.splice(0), ["pii-masker", "prompt-injection", "custom-extra"]);

  const out = await registry.runPreCallHooks(
    {},
    {
      guardrailPlan: {
        entries: {
          "prompt-injection": { enabled: true, priority: 1 },
          "pii-masker": { enabled: false, priority: 10 },
        },
        contentFilter: null,
      },
    }
  );
  assert.deepEqual(log, ["prompt-injection", "custom-extra"], "unlisted guardrails keep running, disabled ones do not");
  const skipped = out.results.find((r) => r.guardrail === "pii-masker");
  assert.equal(skipped?.skipped, true);
});

test("loadGuardrailPlan reads the settings, the key and its groups", async () => {
  assert.equal(await runtime.loadGuardrailPlan({ apiKeyInfo: null }), null, "nothing configured");

  const db = getDbInstance();
  db.prepare("INSERT INTO api_keys (id, name, key, machine_id, created_at) VALUES (?, ?, ?, ?, ?)").run(
    "key-1", "k", "sk-test-guardrail-1", "m", new Date().toISOString()
  );
  const group = createKeyGroup("team-a", "");
  assert.ok(addKeyToGroup("key-1", group.id));

  await updateSettings({
    guardrailAssignments: {
      global: [{ id: "prompt-injection", enabled: true, priority: 20 }],
      byGroup: { [group.id]: { disabled: ["prompt-injection"], enabled: [] } },
      byKey: {},
    },
  });
  runtime.resetGuardrailRuntimeCache();

  const forMember = await runtime.loadGuardrailPlan({ apiKeyInfo: { id: "key-1" } });
  assert.equal(forMember?.entries["prompt-injection"]?.enabled, false);
  const forOther = await runtime.loadGuardrailPlan({ apiKeyInfo: { id: "someone-else" } });
  assert.equal(forOther?.entries["prompt-injection"]?.enabled, true);
});
