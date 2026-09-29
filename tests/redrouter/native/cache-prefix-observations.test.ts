import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "redrouter-cache-prefix-"));
process.env.DATA_DIR = dataDir;
const { getDbInstance, resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { getCachePrefixSummary, pruneCachePrefixObservations, recordCachePrefixObservation } =
  await import("../../../src/lib/db/cachePrefixObservations.ts");
const { observeUpstreamPrefix } =
  await import("../../../open-sse/handlers/chatCore/prefixObservation.ts");
const { resetPrefixObservations } = await import("../../../src/lib/promptCache/prefixDiagnostics.ts");

after(() => {
  resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

const observation = (over: Record<string, unknown>) => ({
  conversationKey: "c1",
  requestIndex: 2,
  messageCount: 10,
  previousMessageCount: 8,
  stablePrefixMessages: 8,
  firstDivergentIndex: -1,
  cause: "none",
  causes: ["none"],
  ...over,
});

test("a summary separates append-only requests from rewritten ones and joins the cache tokens", () => {
  const now = Date.now();
  const iso = new Date(now - 60_000).toISOString();
  for (const over of [
    { cause: "none" },
    { cause: "none" },
    { cause: "history_mutated", firstDivergentIndex: 2, stablePrefixMessages: 2, causes: ["history_mutated"] },
    { cause: "first_request", requestIndex: 1, previousMessageCount: 0, stablePrefixMessages: 0, causes: ["first_request"] },
  ]) {
    recordCachePrefixObservation({
      observation: observation(over) as never,
      provider: "claude",
      model: "claude-opus-5-5",
      timestamp: iso,
    });
  }
  const db = getDbInstance();
  db.prepare(
    `INSERT INTO usage_history (provider, model, tokens_input, tokens_cache_read, tokens_cache_creation, timestamp, success)
     VALUES ('claude', 'claude-opus-5-5', 1000, 100, 600, ?, 1)`
  ).run(iso);

  const summary = getCachePrefixSummary({ now });
  assert.equal(summary.followUpRequests, 3, "the first request of a conversation is not counted");
  assert.deepEqual(
    summary.byCause.map((row) => [row.cause, row.requests]),
    [["none", 2], ["history_mutated", 1]]
  );
  const model = summary.byModel[0];
  assert.equal(model.model, "claude-opus-5-5");
  assert.ok(Math.abs(model.appendOnlyShare - 2 / 3) < 1e-9);
  assert.equal(model.cacheReadShare, 0.1);
  assert.equal(model.cacheWriteShare, 0.6, "writes far above reads is the waste this view exists to show");
});

test("old observations are pruned and recent ones are kept", () => {
  const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
  recordCachePrefixObservation({ observation: observation({}) as never, provider: "x", model: "old", timestamp: old });
  assert.equal(pruneCachePrefixObservations(), 1);
  assert.ok(getCachePrefixSummary().byModel.some((row) => row.model === "claude-opus-5-5"));
});

test("the request hook records a divergence, is silent on failure and can be switched off", () => {
  resetPrefixObservations();
  const messages = (n: number) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `m${i}` }));
  const client = { messages: messages(3) };
  observeUpstreamPrefix({ clientBody: client, finalBody: { messages: messages(4) }, provider: "codex", model: "gpt-6-sol" });
  const rewritten = messages(6);
  rewritten[1] = { role: "assistant", content: "changed" };
  observeUpstreamPrefix({ clientBody: client, finalBody: { messages: rewritten }, provider: "codex", model: "gpt-6-sol" });
  const codex = getCachePrefixSummary().byModel.find((row) => row.model === "gpt-6-sol");
  assert.ok(codex);
  assert.equal(codex.followUpRequests, 1);
  assert.equal(codex.appendOnlyShare, 0);

  assert.doesNotThrow(() => observeUpstreamPrefix({ clientBody: null, finalBody: undefined }));
  assert.doesNotThrow(() => observeUpstreamPrefix({ clientBody: {}, finalBody: { input: "not an array" } }));

  process.env.REDROUTER_CACHE_DIAGNOSTICS = "0";
  observeUpstreamPrefix({ clientBody: client, finalBody: { messages: messages(8) }, provider: "codex", model: "gpt-6-sol" });
  delete process.env.REDROUTER_CACHE_DIAGNOSTICS;
  assert.equal(getCachePrefixSummary().byModel.find((row) => row.model === "gpt-6-sol")?.followUpRequests, 1);
});
