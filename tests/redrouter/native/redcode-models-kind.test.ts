import assert from "node:assert/strict";
import { test } from "node:test";

const { handleGetModelsByKind, isModelKind } =
  await import("../../../src/app/api/v1/models/modelById.ts");

const catalog = {
  object: "list",
  data: [
    { id: "openai/gpt-5", type: "chat" },
    { id: "typesafe-ai/jev-latest", type: "systemone" },
    { id: "claude/claude-opus-5-5", type: "chat" },
  ],
};
const getModels = async () => Response.json(catalog);

test("only kinds with a verified catalog type are routed as kinds", () => {
  assert.equal(isModelKind("systemone"), true);
  assert.equal(isModelKind("web"), false);
  assert.equal(isModelKind("openai"), false);
  assert.equal(isModelKind("toString"), false);
});

test("GET /v1/models/systemone lists System One models in the id format RedCode expects", async () => {
  const response = await handleGetModelsByKind(
    new Request("http://localhost/v1/models/systemone"),
    "systemone",
    getModels
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.object, "list");
  assert.equal(body.id_format, "prefixed");
  assert.deepEqual(
    body.data.map((model: { id: string }) => model.id),
    ["typesafe-ai/jev-latest"]
  );
});

test("a failing catalog is passed through instead of an empty list", async () => {
  const response = await handleGetModelsByKind(
    new Request("http://localhost/v1/models/systemone"),
    "systemone",
    async () => new Response("no", { status: 401 })
  );
  assert.equal(response.status, 401);
});
