import assert from "node:assert/strict";
import test from "node:test";

import { handleGetWebModels } from "../../src/app/api/v1/models/modelById.ts";

const request = new Request("http://localhost/v1/models/web", {
  headers: { Authorization: "Bearer scoped-key" },
});

test("web discovery filters only the calling key's catalog", async () => {
  const response = await handleGetWebModels(request, async (seen) => {
    assert.equal(seen.headers.get("authorization"), "Bearer scoped-key");
    return Response.json({
      object: "list",
      data: [
        { id: "firecrawl/fetch", type: "webFetch" },
        { id: "exa-search/fetch", type: "webFetch", owned_by: "exa-search" },
        { id: "exa-search/search", type: "webSearch" },
        { id: "typesafe-ai/jev-latest", type: "systemone" },
        { id: "openai/gpt", type: "chat" },
      ],
    });
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    object: string;
    data: Array<{ id: string; kind: string; owned_by?: string }>;
  };
  assert.equal(body.object, "list");
  assert.deepEqual(
    body.data.map((entry) => entry.id),
    ["firecrawl/fetch", "exa-search/fetch", "exa-search/search", "exa/fetch", "exa/search"]
  );
  assert.deepEqual(
    body.data.map((entry) => entry.kind),
    ["webFetch", "webFetch", "webSearch", "webFetch", "webSearch"]
  );
  assert.equal(body.data[3]?.owned_by, "exa");
});

test("web discovery preserves catalog authorization failures", async () => {
  const response = await handleGetWebModels(request, async () =>
    Response.json({ error: { message: "Invalid API key" } }, { status: 401 })
  );
  assert.equal(response.status, 401);
});

test("web discovery never adds a legacy fetch alias hidden from the key", async () => {
  const response = await handleGetWebModels(request, async () =>
    Response.json({ data: [{ id: "exa-search/search", type: "webSearch" }] })
  );
  const body = (await response.json()) as { data: Array<{ id: string }> };
  assert.deepEqual(
    body.data.map((entry) => entry.id),
    ["exa-search/search", "exa/search"]
  );
});

test("web discovery includes Ollama and Tavily legacy fetch IDs without duplicates", async () => {
  const response = await handleGetWebModels(request, async () =>
    Response.json({
      data: [
        { id: "ollama-cloud/fetch", type: "webFetch" },
        { id: "tavily-search/fetch", type: "webFetch" },
        { id: "tavily/fetch", type: "webFetch" },
      ],
    })
  );
  const body = (await response.json()) as { data: Array<{ id: string }> };
  assert.deepEqual(
    body.data.map((entry) => entry.id),
    ["ollama-cloud/fetch", "tavily-search/fetch", "tavily/fetch", "ollama/fetch"]
  );
});

test("web discovery maps verified 9router search aliases from visible canonical models", async () => {
  const response = await handleGetWebModels(request, async () =>
    Response.json({
      data: [
        { id: "brave-search/search", type: "webSearch" },
        { id: "google-pse-search/search", type: "webSearch" },
        { id: "serper-search/search", type: "webSearch" },
        { id: "xquik-search/search", type: "webSearch" },
      ],
    })
  );
  const body = (await response.json()) as { data: Array<{ id: string }> };
  assert.deepEqual(
    body.data.map((entry) => entry.id),
    [
      "brave-search/search",
      "google-pse-search/search",
      "serper-search/search",
      "xquik-search/search",
      "brave/search",
      "gpse/search",
      "serper/search",
      "xquik/search",
    ]
  );
});

test("GLM search appears only when the calling key can see it", async () => {
  const visible = await handleGetWebModels(request, async () =>
    Response.json({ data: [{ id: "glm/search", type: "webSearch" }] })
  );
  const visibleBody = (await visible.json()) as { data: Array<{ id: string }> };
  assert.deepEqual(
    visibleBody.data.map((entry) => entry.id),
    ["glm/search"]
  );

  const hidden = await handleGetWebModels(request, async () => Response.json({ data: [] }));
  const hiddenBody = (await hidden.json()) as { data: Array<{ id: string }> };
  assert.deepEqual(hiddenBody.data, []);
});

test("web discovery fails closed on a malformed catalog", async () => {
  const response = await handleGetWebModels(request, async () => Response.json({ data: null }));
  assert.equal(response.status, 502);
  assert.deepEqual((await response.json())?.error?.message, "Model catalog unavailable");
});
