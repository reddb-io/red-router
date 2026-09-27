import assert from "node:assert/strict";
import test from "node:test";

import { ollamaCloudFetch } from "../../open-sse/executors/ollama-cloud-fetch.ts";
import { WEB_FETCH_PROVIDERS, handleWebFetch } from "../../open-sse/handlers/webFetch.ts";
import { webFetchInput } from "../../open-sse/mcp-server/schemas/tools.ts";
import { v1WebFetchSchema } from "../../src/shared/validation/schemas/apiV1.ts";
import { getProviderById } from "../../src/shared/constants/providers.ts";

test("Ollama Cloud web fetch is registered in provider, HTTP and MCP contracts", () => {
  assert.ok(WEB_FETCH_PROVIDERS.includes("ollama-cloud"));
  assert.ok(getProviderById("ollama-cloud")?.serviceKinds?.includes("webFetch"));
  assert.equal(
    v1WebFetchSchema.parse({ url: "https://example.test", provider: "ollama-cloud" }).provider,
    "ollama-cloud"
  );
  assert.equal(
    webFetchInput.parse({ url: "https://example.test", provider: "ollama-cloud" }).provider,
    "ollama-cloud"
  );
});

test("Ollama Cloud fetch uses the selected account key and returns bounded content", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://ollama.com/api/web_fetch");
    assert.equal(init?.method, "POST");
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer ollama-test-key");
    assert.deepEqual(JSON.parse(String(init?.body)), { url: "https://example.test/article" });
    return Response.json({
      content: "Article body",
      title: "Article",
      links: ["https://example.test/more"],
    });
  };
  try {
    const result = await handleWebFetch(
      { url: "https://example.test/article", provider: "ollama-cloud", include_metadata: true },
      { apiKey: "ollama-test-key" },
      "ollama-cloud"
    );
    assert.deepEqual(result, {
      success: true,
      data: {
        provider: "ollama-cloud",
        url: "https://example.test/article",
        content: "Article body",
        links: ["https://example.test/more"],
        metadata: { title: "Article", description: null },
        screenshot_url: null,
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Ollama Cloud fetch rejects missing keys and unsupported formats before dispatch", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network must not be used");
  };
  try {
    assert.equal(
      (
        await ollamaCloudFetch({
          url: "https://example.test",
          format: "markdown",
          includeMetadata: false,
          credentials: {},
        })
      ).status,
      401
    );
    for (const format of ["html", "links", "screenshot"] as const) {
      assert.equal(
        (
          await ollamaCloudFetch({
            url: "https://example.test",
            format,
            includeMetadata: false,
            credentials: { apiKey: "ollama-test-key" },
          })
        ).status,
        400
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Ollama Cloud fetch preserves failure status without exposing upstream details", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("secret at /srv/private", { status: 429 });
  try {
    const result = await ollamaCloudFetch({
      url: "https://example.test",
      format: "markdown",
      includeMetadata: false,
      credentials: { apiKey: "ollama-test-key" },
    });
    assert.equal(result.status, 429);
    assert.doesNotMatch(result.error || "", /secret|private|srv/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Ollama Cloud fetch fails closed on malformed or overlarge success responses", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const body of [JSON.stringify({ title: "No content" }), "x".repeat(2 * 1024 * 1024 + 1)]) {
      globalThis.fetch = async () => new Response(body);
      const result = await ollamaCloudFetch({
        url: "https://example.test",
        format: "markdown",
        includeMetadata: false,
        credentials: { apiKey: "ollama-test-key" },
      });
      assert.equal(result.success, false);
      assert.equal(result.status, 502);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
