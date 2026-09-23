// Disabled models and per-key model rules are enforced where a request resolves
// to a provider/model, and combos skip a member that may not be called.
import { beforeAll, describe, expect, it } from "vitest";

let access;
let repo;
let db;
let combo;
let errors;

beforeAll(async () => {
  db = await import("@/lib/db/index.js");
  repo = await import("@/lib/db/repos/apiKeysRepo.js");
  access = await import("@/lib/modelAccess.js");
  combo = await import("../../open-sse/services/combo.js");
  errors = await import("../../open-sse/utils/error.js");
});

async function keyWith(modelAccess) {
  const key = await repo.createApiKey("rules", "m1");
  await repo.updateApiKey(key.id, { modelAccess });
  return key.key;
}

describe("globs", () => {
  it("match case-insensitively, with * crossing slashes", () => {
    expect(access.globToRegExp("CC/claude-*").test("cc/claude-opus-5-5")).toBe(true);
    expect(access.globToRegExp("*opus*").test("claude-code/claude-opus-5-5")).toBe(true);
    expect(access.globToRegExp("gpt-?").test("gpt-5")).toBe(true);
    expect(access.globToRegExp("gpt-?").test("gpt-55")).toBe(false);
    expect(access.globToRegExp("a.b").test("axb")).toBe(false);
  });
});

describe("normalizeModelAccess", () => {
  it("treats all, bad modes and empty deny lists as unrestricted", () => {
    expect(access.normalizeModelAccess(null)).toBeNull();
    expect(access.normalizeModelAccess({ mode: "all", patterns: ["x"] })).toBeNull();
    expect(access.normalizeModelAccess({ mode: "nope", patterns: ["x"] })).toBeNull();
    expect(access.normalizeModelAccess({ mode: "deny", patterns: [" "] })).toBeNull();
  });

  it("keeps an empty allow list (a key that may call nothing) and dedupes patterns", () => {
    expect(access.normalizeModelAccess({ mode: "allow", patterns: [] })).toEqual({ mode: "allow", patterns: [] });
    expect(access.normalizeModelAccess({ mode: "allow", patterns: ["a/*", "A/*", " b "] })).toEqual({ mode: "allow", patterns: ["a/*", "b"] });
  });
});

describe("modelAccessNames", () => {
  it("covers the requested name and every prefix of the provider", () => {
    const names = access.modelAccessNames({ providerId: "claude", model: "claude-opus-5-5", requested: "my-alias" });
    expect(names).toEqual(expect.arrayContaining([
      "my-alias", "claude-opus-5-5", "cc/claude-opus-5-5", "claude/claude-opus-5-5", "claude-code/claude-opus-5-5",
    ]));
  });

  it("drops a thinking suffix", () => {
    const names = access.modelAccessNames({ providerId: "openai", model: "gpt-5(high)", requested: "openai/gpt-5(high)" });
    expect(names).toContain("openai/gpt-5");
  });
});

describe("disabled models", () => {
  it("block the model under any of its provider's prefixes", async () => {
    await db.disableModels("cc", ["claude-opus-5"]);
    const denial = await access.checkModelAccess({ providerId: "claude", model: "claude-opus-5", requested: "claude-code/claude-opus-5" });
    expect(denial).toMatchObject({ reason: "model_disabled", status: 403 });
    expect(await access.checkModelAccess({ providerId: "claude", model: "claude-opus-5-5" })).toBeNull();
  });

  it("are keyed by provider id for compatible nodes", async () => {
    await db.disableModels("openai-compatible-node-1", ["local-model"]);
    expect(await access.isModelDisabled("openai-compatible-node-1", "local-model")).toBe(true);
    expect(await access.isModelDisabled("openai-compatible-node-2", "local-model")).toBe(false);
  });

  it("apply with no API key at all", async () => {
    await db.disableModels("openai", ["gpt-4o"]);
    expect(await access.checkModelAccess({ apiKey: null, providerId: "openai", model: "gpt-4o(low)" })).toMatchObject({ reason: "model_disabled" });
  });
});

describe("per-key model rules", () => {
  it("allow mode lets only matching models through, by any spelling", async () => {
    const apiKey = await keyWith({ mode: "allow", patterns: ["cc/claude-*"] });
    // The slug spelling is caught by a rule written with the short alias.
    expect(await access.checkModelAccess({ apiKey, providerId: "claude", model: "claude-sonnet-5", requested: "claude-code/claude-sonnet-5" })).toBeNull();
    expect(await access.checkModelAccess({ apiKey, providerId: "openai", model: "gpt-5", requested: "openai/gpt-5" }))
      .toMatchObject({ reason: "model_not_allowed", status: 403 });
  });

  it("deny mode cannot be bypassed through an alias", async () => {
    const apiKey = await keyWith({ mode: "deny", patterns: ["openai/*"] });
    expect(await access.checkModelAccess({ apiKey, providerId: "openai", model: "gpt-5", requested: "my-gpt" }))
      .toMatchObject({ reason: "model_not_allowed" });
    expect(await access.checkModelAccess({ apiKey, providerId: "claude", model: "claude-sonnet-5", requested: "cc/claude-sonnet-5" })).toBeNull();
  });

  it("a key allowed to call a combo may call its members; deny rules still apply to members", async () => {
    const allowKey = await keyWith({ mode: "allow", patterns: ["team-*"] });
    const comboAccess = await access.checkComboAccess(allowKey, "team-fast");
    expect(comboAccess).toEqual({ denial: null, granted: true });
    expect(await access.checkModelAccess({ apiKey: allowKey, providerId: "openai", model: "gpt-5", requested: "openai/gpt-5", grantedByCombo: true })).toBeNull();
    expect((await access.checkComboAccess(allowKey, "other")).denial).toMatchObject({ reason: "model_not_allowed" });

    const denyKey = await keyWith({ mode: "deny", patterns: ["openai/*"] });
    expect(await access.checkComboAccess(denyKey, "team-fast")).toEqual({ denial: null, granted: false });
    expect(await access.checkModelAccess({ apiKey: denyKey, providerId: "openai", model: "gpt-5", requested: "openai/gpt-5", grantedByCombo: true }))
      .toMatchObject({ reason: "model_not_allowed" });
  });

  it("an unknown or unrestricted key is not limited by rules", async () => {
    expect(await access.checkModelAccess({ apiKey: "sk-unknown", providerId: "openai", model: "gpt-5" })).toBeNull();
    expect(await access.checkComboAccess("sk-unknown", "anything")).toEqual({ denial: null, granted: false });
  });

  it("round-trips through the repo and the DB export/import", async () => {
    const key = await repo.createApiKey("roundtrip", "m1");
    const updated = await repo.updateApiKey(key.id, { modelAccess: { mode: "deny", patterns: ["x/*"] }, limits: { rpm: 5, tokensPerDay: "", usdPerMonth: 2.5 } });
    expect(updated.modelAccess).toEqual({ mode: "deny", patterns: ["x/*"] });
    expect(updated.limits).toEqual({ rpm: 5, usdPerMonth: 2.5 });
    const dump = await db.exportDb();
    expect(dump.apiKeys.find((k) => k.id === key.id)).toMatchObject({ modelAccess: { mode: "deny", patterns: ["x/*"] }, limits: { rpm: 5, usdPerMonth: 2.5 } });
    // Clearing the rules restores an unrestricted key.
    expect((await repo.updateApiKey(key.id, { modelAccess: null, limits: null }))).toMatchObject({ modelAccess: null, limits: null });
  });
});

describe("combo members that may not be called", () => {
  const log = { info() {}, warn() {}, debug() {}, error() {} };
  const denied = (reason) => errors.responseFromRoutingCandidate({ reason, status: 403, message: "no", retryable: false });

  it("are skipped without ending the combo", async () => {
    const calls = [];
    const ok = new Response("{}", { status: 200 });
    const result = await combo.handleComboChat({
      body: {}, models: ["p/a", "p/b", "p/c"], log, comboName: "skip-test", comboStrategy: "fallback",
      handleSingleModel: async (_b, m) => {
        calls.push(m);
        if (m === "p/a") return denied("model_disabled");
        if (m === "p/b") return denied("model_not_allowed");
        return ok;
      },
    });
    expect(calls).toEqual(["p/a", "p/b", "p/c"]);
    expect(result).toBe(ok);
  });

  it("answer 403 with the member's reason when every member was denied", async () => {
    const result = await combo.handleComboChat({
      body: {}, models: ["p/a", "p/b"], log, comboName: "all-denied", comboStrategy: "fallback",
      handleSingleModel: async () => denied("model_not_allowed"),
    });
    expect(result.status).toBe(403);
    expect(result.headers.get("X-9Router-Reason")).toBe("model_not_allowed");
  });
});
