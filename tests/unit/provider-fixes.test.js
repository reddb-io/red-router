// Provider fixes from the 9router / PentatonicDev review: relay and bypass keep
// request headers, the DNS bypass only runs for a local redirect, Kiro IDC finds
// its profile in its own region, Cline's old envelope unwraps, MiMo v2.6.
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("proxyFetch helpers", () => {
  it("turns any header shape into a plain object", async () => {
    const { toPlainHeaders } = await import("../../open-sse/utils/proxyFetch.js");
    expect(toPlainHeaders(new Headers({ Authorization: "Bearer x", "Content-Type": "application/json" })))
      .toEqual({ authorization: "Bearer x", "content-type": "application/json" });
    expect(toPlainHeaders([["a", "1"]])).toEqual({ a: "1" });
    expect(toPlainHeaders({ b: "2" })).toEqual({ b: "2" });
    expect(toPlainHeaders(undefined)).toEqual({});
  });

  it("recognizes the local addresses a hosts-file redirect answers", async () => {
    const { isLocalAddress } = await import("../../open-sse/utils/proxyFetch.js");
    for (const a of ["127.0.0.1", "::1", "10.0.0.5", "192.168.1.2", "172.20.0.1", "0.0.0.0", "fd00::1"]) expect(isLocalAddress(a), a).toBe(true);
    for (const a of ["142.250.1.1", "172.32.0.1", "8.8.8.8", "2607:f8b0::1"]) expect(isLocalAddress(a), a).toBe(false);
  });

  it("the Vercel relay forwards every header of a Headers object", async () => {
    const seen = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => { seen.push({ url, init }); return new Response("{}"); }));
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    await proxyAwareFetch("https://api.example.com/v1/chat?x=1", {
      method: "POST", headers: new Headers({ Authorization: "Bearer secret", "Content-Type": "application/json" }), body: "{}",
    }, { vercelRelayUrl: "https://relay.example.app" });
    expect(seen[0].url).toBe("https://relay.example.app");
    expect(seen[0].init.headers).toMatchObject({
      authorization: "Bearer secret",
      "content-type": "application/json",
      "x-relay-target": "https://api.example.com",
      "x-relay-path": "/v1/chat?x=1",
    });
  });
});

describe("Kiro IDC profile lookup", () => {
  it("asks the account's own region with the JSON-RPC target and returns its ARN", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ profiles: [
        { arn: "arn:aws:codewhisperer:us-east-1:1:profile/A" },
        { arn: "arn:aws:codewhisperer:eu-central-1:1:profile/B" },
      ] }), { status: 200 });
    }));
    const { fetchKiroProfileArn } = await import("../../src/lib/oauth/providerHelpers.js");
    expect(await fetchKiroProfileArn("tok", "eu-central-1")).toBe("arn:aws:codewhisperer:eu-central-1:1:profile/B");
    expect(calls[0].url).toBe("https://codewhisperer.eu-central-1.amazonaws.com");
    expect(calls[0].init.headers["x-amz-target"]).toBe("AmazonCodeWhispererService.ListAvailableProfiles");
  });

  it("stays fail-soft: null on an error or a bad region", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 403 })));
    const { fetchKiroProfileArn } = await import("../../src/lib/oauth/providerHelpers.js");
    expect(await fetchKiroProfileArn("tok", "us-east-1")).toBeNull();
    expect(await fetchKiroProfileArn("tok", "not a region")).toBeNull();
    expect(await fetchKiroProfileArn(null)).toBeNull();
  });
});

describe("Cline envelope", () => {
  it("unwraps the success envelope and the older data-only shape, never an error", async () => {
    const { unwrapClineEnvelope } = await import("../../open-sse/shared/clineEnvelope.js");
    const completion = { choices: [{ message: { content: "hi" } }] };
    expect(unwrapClineEnvelope({ success: true, data: completion }, "cline")).toBe(completion);
    expect(unwrapClineEnvelope({ data: completion }, "cline")).toBe(completion);
    const error = { success: false, data: { choices: [] }, error: "bad" };
    expect(unwrapClineEnvelope(error, "cline")).toBe(error);
    const dataOnly = { data: { message: "no choices" } };
    expect(unwrapClineEnvelope(dataOnly, "cline")).toBe(dataOnly);
    expect(unwrapClineEnvelope({ data: completion }, "openai")).toEqual({ data: completion });
  });
});

describe("MiMo v2.6", () => {
  it("routes the v2.6 models through the account service and maps retired preview ids", async () => {
    const { XiaomiMimoExecutor } = await import("../../open-sse/executors/xiaomi-mimo.js");
    const { MIMO_API_BASE } = await import("../../open-sse/shared/mimoAccount.js");
    const ex = new XiaomiMimoExecutor();
    for (const id of ["mimo-v2.6-pro", "mimo-v2.6-flash", "mimo-v2.6-pro-ultraspeed", "mimo-x-pro-preview"]) {
      expect(XiaomiMimoExecutor.isPreviewModel(id), id).toBe(true);
      expect(ex.buildUrl(id, true)).toBe(`${MIMO_API_BASE}/api/route/chat/completions`);
    }
    const out = ex.transformRequest("mimo-x-flash-preview", { model: "xiaomi/mimo-x-flash-preview", messages: [] }, true, {});
    expect(out.model).toBe("xiaomi/mimo-v2.6-flash");
    expect(XiaomiMimoExecutor.isPreviewModel("mimo-v2.5-pro")).toBe(false);
  });
});

describe("MITM DNS bypass", () => {
  // A bypass host whose system DNS answer is a public address: the normal fetch
  // path is right, and the forced Google DNS lookup must not run (#4261).
  it("uses the normal fetch when the system resolver answers a public address", async () => {
    const resolverCalls = [];
    vi.doMock("dns/promises", () => ({ lookup: async () => ({ address: "142.250.1.1", family: 4 }) }));
    vi.doMock("dns", () => ({ default: { Resolver: class { constructor() { resolverCalls.push("resolver"); } setServers() {} resolve4(h, cb) { cb(null, ["1.2.3.4"]); } } } }));
    const fetchMock = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    const res = await proxyAwareFetch("https://api2.cursor.sh/x", { method: "POST" });
    expect(await res.text()).toBe("ok");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(resolverCalls).toEqual([]);
    vi.doUnmock("dns/promises");
    vi.doUnmock("dns");
  });

  it("falls back to the normal fetch when the forced lookup fails", async () => {
    vi.doMock("dns/promises", () => ({ lookup: async () => ({ address: "127.0.0.1", family: 4 }) }));
    vi.doMock("dns", () => ({ default: { Resolver: class { setServers() {} resolve4(h, cb) { cb(new Error("ETIMEOUT")); } } } }));
    const fetchMock = vi.fn(async () => new Response("fallback"));
    vi.stubGlobal("fetch", fetchMock);
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    const res = await proxyAwareFetch("https://api2.cursor.sh/y", { method: "POST" });
    expect(await res.text()).toBe("fallback");
    vi.doUnmock("dns/promises");
    vi.doUnmock("dns");
  });
});
