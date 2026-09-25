import http from "node:http";
import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Each test gets a fresh module graph and DB (DATA_DIR is a per-file sandbox).
async function setup() {
  vi.resetModules();
  const repo = await import("@/lib/db/repos/usageSinksRepo.js");
  const { saveRequestUsage } = await import("@/lib/db/repos/usageRepo.js");
  const { createApiKey, getApiKeys, updateApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
  const engine = await import("@/lib/usageSinks/engine.js");
  const { getDb } = await import("@/lib/db/kysely.js");
  const db = await getDb();
  await db.deleteFrom("usageDeliveries").execute();
  await db.deleteFrom("usageSinks").execute();
  await db.deleteFrom("usageHistory").execute();
  await db.deleteFrom("apiKeys").execute();

  // A fixed past date: the real clock is always ahead of it, so a delivery that
  // took its time from the wall clock instead of deps.now() would never be due.
  let nowMs = Date.parse("2026-01-05T10:03:00.000Z");
  const sent = [];
  let respond = () => ({ ok: true, status: 200 });
  const deps = {
    repo,
    getApiKeys,
    now: () => new Date(nowMs),
    transports: {
      webhook: async ({ id, payload }) => {
        sent.push({ id, payload });
        return { retryable: true, error: null, ...respond(id, payload) };
      },
    },
  };
  let second = 0;
  const record = (apiKey, model = "gpt-4o-mini", extra = {}) => saveRequestUsage({
    provider: "openai", model, apiKey, endpoint: "/v1/chat/completions",
    timestamp: new Date(nowMs + (second++) * 1000).toISOString(),
    tokens: { prompt_tokens: 100, completion_tokens: 20 }, ...extra,
  });
  return {
    repo, engine, deps, sent, record, createApiKey, updateApiKey,
    setNow: (iso) => { nowMs = Date.parse(iso); },
    setResponse: (fn) => { respond = fn; },
  };
}

describe("usage sinks engine", () => {
  let t;
  beforeEach(async () => { t = await setup(); });

  it("consolidates a clock-aligned window per API key and never sends a raw key", async () => {
    const a = await t.createApiKey("acme", "machine-1", ["customer-a"]);
    const b = await t.createApiKey("globex", "machine-1");
    await t.record("sk-before-sink-exists"); // history before the sink is not re-sent
    const sink = await t.repo.createUsageSink({ name: "billing", type: "webhook", config: { url: "https://billing.test/hook" }, mode: "window", windowSec: 900 });

    await t.engine.runUsageSinksTick(t.deps);
    expect((await t.repo.getUsageSinkById(sink.id)).nextWindowEnd).toBe("2026-01-05T10:15:00.000Z");

    await t.record(a.key); await t.record(a.key, "gpt-4o"); await t.record(a.key, "gpt-4o", { status: "error" });
    await t.record(b.key);
    await t.engine.runUsageSinksTick(t.deps);
    expect(t.sent).toHaveLength(0); // window still open

    t.setNow("2026-01-05T10:15:02.000Z");
    await t.engine.runUsageSinksTick(t.deps);
    expect(t.sent).toHaveLength(1);
    const { payload } = t.sent[0];
    expect(payload).toMatchObject({
      type: "usage.window", version: 1,
      window: { start: "2026-01-05T10:00:00.000Z", end: "2026-01-05T10:15:00.000Z", sizeSec: 900 },
    });
    const acme = payload.keys.find((k) => k.apiKey?.name === "acme");
    expect(acme.apiKey).toMatchObject({ id: a.id, tags: ["customer-a"] });
    expect(acme.totals).toMatchObject({ requests: 3, errors: 1, promptTokens: 300, completionTokens: 60 });
    expect(acme.byModel.map((m) => `${m.model}:${m.requests}`).sort()).toEqual(["gpt-4o-mini:1", "gpt-4o:2"]);
    expect(payload.keys.find((k) => k.apiKey?.name === "globex").totals.requests).toBe(1);
    expect(JSON.stringify(payload)).not.toContain(a.key);
    expect(JSON.stringify(payload)).not.toContain(b.key);

    // A request recorded after the boundary goes to the next window, once.
    await t.record(b.key);
    t.setNow("2026-01-05T10:30:01.000Z");
    await t.engine.runUsageSinksTick(t.deps);
    expect(t.sent).toHaveLength(2);
    expect(t.sent[1].payload.window.start).toBe("2026-01-05T10:15:00.000Z");
    expect(t.sent[1].payload.keys).toHaveLength(1);
    expect(t.sent[1].payload.range.fromId).toBe(payload.range.toId + 1);
  });

  it("sends each request in instant mode, only for the keys the filter selects", async () => {
    const a = await t.createApiKey("acme", "machine-1", ["billable"]);
    const b = await t.createApiKey("internal", "machine-1");
    await t.repo.createUsageSink({ name: "live", type: "webhook", config: { url: "https://x.test" }, mode: "instant", filter: { tags: ["billable"] } });
    await t.record(a.key); await t.record(b.key); await t.record(a.key); await t.record(null);
    await t.engine.runUsageSinksTick(t.deps);
    expect(t.sent.map((s) => s.payload.type)).toEqual(["usage.recorded", "usage.recorded"]);
    expect(t.sent.every((s) => s.payload.event.apiKey.id === a.id)).toBe(true);
    await t.engine.runUsageSinksTick(t.deps);
    expect(t.sent).toHaveLength(2); // cursor moved: nothing re-sent
  });

  it("moves the cursor only from the value it read, so a second instance writes nothing", async () => {
    const sink = await t.repo.createUsageSink({ name: "s", type: "webhook", config: { url: "https://x.test" }, mode: "instant" });
    const won = await t.repo.commitSinkBatch(sink.id, sink.cursorId, sink.cursorId + 5, []);
    const lost = await t.repo.commitSinkBatch(sink.id, sink.cursorId, sink.cursorId + 5, [{ id: "ue_dup", kind: "event", payload: {} }]);
    expect([won, lost]).toEqual([true, false]);
    expect(await t.repo.getDeliveryById("ue_dup")).toBeNull();
  });

  it("retries a failed delivery with backoff, then delivers it with the same id", async () => {
    const sink = await t.repo.createUsageSink({ name: "s", type: "webhook", config: { url: "https://x.test" }, mode: "instant" });
    await t.record(null);
    t.setResponse(() => ({ ok: false, status: 500, error: "HTTP 500" }));
    await t.engine.runUsageSinksTick(t.deps);
    let [delivery] = await t.repo.getDeliveries(sink.id);
    expect(delivery).toMatchObject({ status: "pending", attempts: 1, lastStatus: 500 });
    expect(delivery.nextAttemptAt).toBe("2026-01-05T10:03:30.000Z");

    await t.engine.runUsageSinksTick(t.deps); // not due yet
    expect(t.sent).toHaveLength(1);

    t.setResponse(() => ({ ok: true, status: 204 }));
    t.setNow("2026-01-05T10:03:31.000Z");
    await t.engine.runUsageSinksTick(t.deps);
    [delivery] = await t.repo.getDeliveries(sink.id);
    expect(delivery).toMatchObject({ status: "delivered", attempts: 2, lastStatus: 204 });
    expect(t.sent[0].id).toBe(t.sent[1].id);
  });

  it("gives up at once when the endpoint answers 410 Gone", async () => {
    const sink = await t.repo.createUsageSink({ name: "s", type: "webhook", config: { url: "https://x.test" }, mode: "instant" });
    await t.record(null);
    t.setResponse(() => ({ ok: false, status: 410, retryable: false, error: "HTTP 410" }));
    await t.engine.runUsageSinksTick(t.deps);
    const [delivery] = await t.repo.getDeliveries(sink.id);
    expect(delivery).toMatchObject({ status: "dead", attempts: 1, lastStatus: 410 });
  });
});

describe("webhook transport", () => {
  it("signs the body per Standard Webhooks so a receiver can verify it", async () => {
    const { sendWebhook } = await import("@/lib/usageSinks/webhook.js");
    const received = await new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => { res.writeHead(204).end(); server.close(); resolve({ headers: req.headers, body }); });
      });
      server.listen(0, "127.0.0.1", async () => {
        const secret = `whsec_${Buffer.from("topsecret").toString("base64")}`;
        const result = await sendWebhook({ config: { url: `http://127.0.0.1:${server.address().port}/hook`, secret }, id: "ub_1", payload: { hello: "world" } });
        if (!result.ok) reject(new Error(result.error));
      });
    });
    const { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": sig } = received.headers;
    expect(id).toBe("ub_1");
    const expected = createHmac("sha256", Buffer.from("topsecret")).update(`${id}.${ts}.${received.body}`).digest("base64");
    expect(sig).toBe(`v1,${expected}`);
    expect(JSON.parse(received.body)).toEqual({ hello: "world" });
  });
});
