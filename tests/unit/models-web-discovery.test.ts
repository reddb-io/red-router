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
        { id: "exa-search/search", type: "webSearch" },
        { id: "typesafe-ai/jev-latest", type: "systemone" },
        { id: "openai/gpt", type: "chat" },
      ],
    });
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { object: string; data: Array<{ id: string }> };
  assert.equal(body.object, "list");
  assert.deepEqual(
    body.data.map((entry) => entry.id),
    ["firecrawl/fetch", "exa-search/search"]
  );
});

test("web discovery preserves catalog authorization failures", async () => {
  const response = await handleGetWebModels(request, async () =>
    Response.json({ error: { message: "Invalid API key" } }, { status: 401 })
  );
  assert.equal(response.status, 401);
});

test("web discovery fails closed on a malformed catalog", async () => {
  const response = await handleGetWebModels(request, async () => Response.json({ data: null }));
  assert.equal(response.status, 502);
  assert.deepEqual((await response.json())?.error?.message, "Model catalog unavailable");
});
