import { describe, expect, it } from "vitest";
import { runWithProbeTrace, tracedFetch, decisiveRequest } from "@/app/api/providers/[id]/test/probeTrace.js";

const fakeFetch = (status, body, headers = {}) => async () => new Response(body, { status, headers });

describe("connection test probe trace", () => {
  it("records status, size and a key-free URL for each request", async () => {
    const modelsBody = JSON.stringify({ data: [1, 2, 3] });
    const { result, requests } = await runWithProbeTrace(async () => {
      await tracedFetch(fakeFetch(401, "denied", { "content-length": "6" }), "https://auth.test/token?key=secret", { method: "post" });
      const res = await tracedFetch(fakeFetch(200, modelsBody), "https://api.test/v1/models?api_key=secret");
      return (await res.json()).data.length;
    });

    expect(result).toBe(3);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ method: "POST", url: "https://auth.test/token", status: 401, bytes: 6 });
    // No content-length: the size comes from a clone of the body, and the caller can still read it.
    expect(requests[1]).toMatchObject({ method: "GET", url: "https://api.test/v1/models", status: 200, bytes: Buffer.byteLength(modelsBody) });
    expect(requests.every((r) => typeof r.durationMs === "number")).toBe(true);
    expect(JSON.stringify(requests)).not.toContain("secret");
    expect(decisiveRequest(requests).status).toBe(200);
  });

  it("records a request that never got a response", async () => {
    const { requests } = await runWithProbeTrace(async () => {
      await tracedFetch(async () => { throw new TypeError("fetch failed"); }, "https://down.test/v1/models").catch(() => {});
    });
    expect(requests).toEqual([expect.objectContaining({ url: "https://down.test/v1/models", status: null, error: "fetch failed" })]);
    expect(decisiveRequest(requests).error).toBe("fetch failed");
  });

  it("does nothing outside a test", async () => {
    const res = await tracedFetch(fakeFetch(204, null), "https://api.test/ping");
    expect(res.status).toBe(204);
  });
});
