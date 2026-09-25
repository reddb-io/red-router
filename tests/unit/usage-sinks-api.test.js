import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const json = (body) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("usage sinks API", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("next/server", () => ({
      NextResponse: {
        json(body, init = {}) {
          return new Response(JSON.stringify(body), { status: init.status || 200, headers: { "Content-Type": "application/json" } });
        },
      },
    }));
    const { getDb } = await import("@/lib/db/kysely.js");
    const db = await getDb();
    await db.deleteFrom("usageDeliveries").execute();
    await db.deleteFrom("usageSinks").execute();
  });
  afterEach(() => {
    vi.doUnmock("next/server");
    vi.resetModules();
  });

  it("names the keys a sink filters on without loading every key", async () => {
    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    const key = await createApiKey("Acme", "m", null, null);
    const { POST, GET } = await import("@/app/api/usage-sinks/route.js");
    await POST(new Request("https://local.test/api/usage-sinks", json({ name: "s", type: "webhook", config: { url: "https://b.test" }, mode: "instant", filter: { apiKeyIds: [key.id, "gone"] } })));
    const { sinks } = await (await GET()).json();
    expect(sinks[0].filterKeys).toEqual([{ id: key.id, name: "Acme" }, { id: "gone", name: null, deleted: true }]);
  });

  it("validates a sink and never returns its secret", async () => {
    const { POST, GET } = await import("@/app/api/usage-sinks/route.js");
    const bad = await POST(new Request("https://local.test/api/usage-sinks", json({ name: "x", type: "webhook", config: { url: "ftp://nope" }, mode: "window", windowSec: 900 })));
    expect(bad.status).toBe(400);
    const badWindow = await POST(new Request("https://local.test/api/usage-sinks", json({ name: "x", type: "webhook", config: { url: "https://b.test" }, mode: "window", windowSec: 42 })));
    expect(badWindow.status).toBe(400);

    const created = await POST(new Request("https://local.test/api/usage-sinks", json({
      name: "Billing", type: "webhook", config: { url: "https://billing.test/hook", secret: "whsec_c2VjcmV0MTIzNA==" }, mode: "window", windowSec: 900,
    })));
    expect(created.status).toBe(201);
    const { sink } = await created.json();
    expect(sink.config).toEqual({ url: "https://billing.test/hook", hasSecret: true, secretHint: "…NA==" });

    const list = await (await GET()).json();
    expect(JSON.stringify(list)).not.toContain("c2VjcmV0MTIzNA");

    // An update without a secret keeps the stored one.
    const { PUT } = await import("@/app/api/usage-sinks/[id]/route.js");
    const updated = await (await PUT(new Request("https://local.test/x", { ...json({ config: { url: "https://billing.test/v2", secret: "" } }), method: "PUT" }), { params: Promise.resolve({ id: sink.id }) })).json();
    expect(updated.sink.config).toMatchObject({ url: "https://billing.test/v2", hasSecret: true });
    const { getUsageSinkById } = await import("@/lib/db/repos/usageSinksRepo.js");
    expect((await getUsageSinkById(sink.id)).config.secret).toBe("whsec_c2VjcmV0MTIzNA==");
  });

  it("sends a signed sample payload from Send test and reports the response", async () => {
    const hits = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => { hits.push({ headers: req.headers, body: JSON.parse(body) }); res.writeHead(202).end("accepted"); });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${server.address().port}/hook?token=abc`;
      const { POST } = await import("@/app/api/usage-sinks/route.js");
      const { sink } = await (await POST(new Request("https://local.test/api/usage-sinks", json({ name: "B", type: "webhook", config: { url, secret: "plain-secret" }, mode: "window", windowSec: 300 })))).json();
      const { POST: test } = await import("@/app/api/usage-sinks/[id]/test/route.js");
      const result = await (await test(new Request("https://local.test/x", json({})), { params: Promise.resolve({ id: sink.id }) })).json();

      expect(result).toMatchObject({ valid: true, error: null, probe: { method: "POST", status: 202, bytes: 8 } });
      expect(result.probe.url).not.toContain("token"); // query strings stay hidden
      expect(hits).toHaveLength(1);
      expect(hits[0].headers["webhook-signature"]).toMatch(/^v1,/);
      expect(hits[0].body).toMatchObject({ type: "usage.window", test: true, window: { sizeSec: 300 } });
    } finally {
      server.close();
    }
  });
});
