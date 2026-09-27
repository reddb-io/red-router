import assert from "node:assert/strict";
import test from "node:test";

import { exaFetch } from "../../open-sse/executors/exa-fetch.ts";
import { WEB_FETCH_PROVIDERS, handleWebFetch } from "../../open-sse/handlers/webFetch.ts";
import { webFetchInput } from "../../open-sse/mcp-server/schemas/tools.ts";
import { v1WebFetchSchema } from "../../src/shared/validation/schemas/apiV1.ts";

test("Exa web fetch is exposed by the HTTP, MCP and handler contracts", () => {
  assert.ok(WEB_FETCH_PROVIDERS.includes("exa-search"));
  assert.equal(
    v1WebFetchSchema.parse({ url: "https://example.test", provider: "exa-search" }).provider,
    "exa-search"
  );
  assert.equal(
    webFetchInput.parse({ url: "https://example.test", provider: "exa-search" }).provider,
    "exa-search"
  );
});

test("Exa web fetch uses the contents API and the selected account key", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://api.exa.ai/contents");
    assert.equal(init?.method, "POST");
    assert.equal((init?.headers as Record<string, string>)["x-api-key"], "exa-test-key");
    assert.deepEqual(JSON.parse(String(init?.body)), {
      ids: ["https://example.test/article"],
      text: true,
    });
    return Response.json({ results: [{ title: "Article", text: "Article body" }] });
  };
  try {
    const result = await handleWebFetch(
      {
        url: "https://example.test/article",
        provider: "exa-search",
        include_metadata: true,
      },
      { apiKey: "exa-test-key" },
      "exa-search"
    );
    assert.deepEqual(result, {
      success: true,
      data: {
        provider: "exa-search",
        url: "https://example.test/article",
        content: "Article body",
        links: [],
        metadata: { title: "Article", description: null },
        screenshot_url: null,
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Exa web fetch rejects missing keys and unsupported formats before network access", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network must not be used");
  };
  try {
    assert.equal(
      (
        await exaFetch({
          url: "https://example.test",
          format: "markdown",
          includeMetadata: false,
          credentials: {},
        })
      ).status,
      401
    );
    for (const format of ["html", "links", "screenshot"] as const) {
      const result = await exaFetch({
        url: "https://example.test",
        format,
        includeMetadata: false,
        credentials: { apiKey: "exa-test-key" },
      });
      assert.equal(result.status, 400);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Exa web fetch preserves upstream failure status without leaking its body", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("private key at /srv/private", { status: 429 });
  try {
    const result = await exaFetch({
      url: "https://example.test",
      format: "markdown",
      includeMetadata: false,
      credentials: { apiKey: "exa-test-key" },
    });
    assert.equal(result.success, false);
    assert.equal(result.status, 429);
    assert.doesNotMatch(result.error || "", /private|srv/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Exa web fetch rejects malformed or overlarge 200 responses", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const body of [JSON.stringify({ results: [] }), "x".repeat(2 * 1024 * 1024 + 1)]) {
      globalThis.fetch = async () => new Response(body);
      const result = await exaFetch({
        url: "https://example.test",
        format: "markdown",
        includeMetadata: false,
        credentials: { apiKey: "exa-test-key" },
      });
      assert.equal(result.success, false);
      assert.equal(result.status, 502);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
