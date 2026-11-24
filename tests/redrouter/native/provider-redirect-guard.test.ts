import assert from "node:assert/strict";
import { test } from "node:test";
import { guardedProviderFetch } from "../../../open-sse/executors/guardedRedirect.ts";
import { createWreqTransportClient } from "../../../open-sse/utils/tlsClient.ts";
import { parseAndValidateNonMetadataUrl } from "../../../src/shared/network/outboundUrlGuard.ts";

test("provider redirects validate every destination before sending a request", async () => {
  const requests: string[] = [];
  const fakeFetch: typeof fetch = async (input) => {
    requests.push(String(input));
    return new Response(null, { status: 307, headers: { location: "http://169.254.169.254/" } });
  };
  await assert.rejects(
    guardedProviderFetch("http://127.0.0.1/provider", { method: "POST", body: "secret" },
      parseAndValidateNonMetadataUrl, fakeFetch),
    /metadata/i
  );
  assert.deepEqual(requests, ["http://127.0.0.1/provider"]);
  assert.throws(() => parseAndValidateNonMetadataUrl("http://169.254.169.254/"), /metadata/i);
});

test("cross-origin redirects strip credentials and preserve or rewrite methods", async () => {
  for (const status of [301, 302, 303]) {
    const requests: RequestInit[] = [];
    const fakeFetch: typeof fetch = async (_input, init) => {
      requests.push(init ?? {});
      return requests.length === 1
        ? new Response(null, { status, headers: { location: "https://other.example/next" } })
        : new Response("ok");
    };
    await guardedProviderFetch("https://first.example/path", {
      method: "POST", body: "payload", headers: { authorization: "secret", "x-api-key": "secret", "content-type": "application/json" },
    }, () => {}, fakeFetch);
    const next = requests[1];
    const headers = new Headers(next.headers);
    assert.equal(headers.get("authorization"), null);
    assert.equal(headers.get("x-api-key"), null);
    assert.equal(next.method, "GET");
    assert.equal(next.body, undefined);
    assert.equal(headers.has("content-type"), false);
  }
});

test("307 and 308 cannot send request bodies to another origin", async () => {
  for (const status of [307, 308]) {
    let calls = 0;
    const fakeFetch: typeof fetch = async () => {
      calls++;
      return new Response(null, { status, headers: { location: "https://other.example/next" } });
    };
    await assert.rejects(guardedProviderFetch("https://first.example/", {
      method: "POST", body: "private prompt",
    }, () => {}, fakeFetch), /cross-origin/i);
    assert.equal(calls, 1);
  }
});

test("same-origin 307 retains the request body and provider credentials", async () => {
  const requests: RequestInit[] = [];
  const fakeFetch: typeof fetch = async (_input, init) => {
    requests.push(init ?? {});
    return requests.length === 1
      ? new Response(null, { status: 307, headers: { location: "/next" } })
      : new Response("ok");
  };
  await guardedProviderFetch("https://first.example/", {
    method: "POST", body: "prompt", headers: { authorization: "Bearer provider" },
  }, () => {}, fakeFetch);
  assert.equal(requests[1].body, "prompt");
  assert.equal(new Headers(requests[1].headers).get("authorization"), "Bearer provider");
});

test("redirects stop at the hop limit and explicit manual mode is retained", async () => {
  let calls = 0;
  const fakeFetch: typeof fetch = async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: "/again" } });
  };
  await assert.rejects(guardedProviderFetch("https://first.example/", {}, () => {}, fakeFetch), /limit/i);
  assert.equal(calls, 6);
  calls = 0;
  const result = await guardedProviderFetch("https://first.example/", { redirect: "manual" }, () => {}, fakeFetch);
  assert.equal(result.status, 302);
  assert.equal(calls, 1);
});

test("fingerprinted transport forwards the requested redirect mode", async () => {
  let redirect: unknown;
  const client = createWreqTransportClient({
    browser: "chrome",
    os: "linux",
    runtimeLoader: async () => ({
      createTransport: async () => ({ close: () => {} }),
      fetch: async (_url, options) => {
        redirect = options.redirect;
        return { status: 302, headers: {}, body: null };
      },
    }),
  });
  const request = client.request("https://provider.example/", { redirect: "manual" });
  await request;
  request.releaseTransport();
  assert.equal(redirect, "manual");
});
