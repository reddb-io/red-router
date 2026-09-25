// An OpenCode Go connection also offers the workspace's OpenCode Zen JEV models on
// /v1/models/systemone (the same workspace key serves Zen), and nowhere in chat.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let buildModelsList;
let resetOpenCodeCatalogs;
let goConnection;

const ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models";
const GO_MODELS_URL = "https://opencode.ai/zen/go/v1/models";

function list(ids) {
  return Response.json({ object: "list", data: ids.map((id) => ({ id, object: "model" })) });
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rr-opencode-s1-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  goConnection = await db.createProviderConnection({ provider: "opencode-go", authType: "apikey", name: "OpenCode workspace", apiKey: "k-opencode" });
  ({ buildModelsList } = await import("../../src/app/api/v1/models/route.js"));
  ({ resetOpenCodeCatalogs } = await import("../../open-sse/services/opencodeCatalog.js"));
});

beforeEach(() => {
  resetOpenCodeCatalogs();
  vi.unstubAllGlobals();
});

afterAll(() => {
  vi.unstubAllGlobals();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

function stubOpenCode(lists) {
  const fetchMock = vi.fn(async (url) => {
    const ids = lists[String(url)];
    return ids ? list(ids) : new Response("unavailable", { status: 503 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("/v1/models/systemone with an OpenCode Go connection", () => {
  it("lists Zen's JEV models, attributed to OpenCode Zen through the Go connection", async () => {
    stubOpenCode({ [ZEN_MODELS_URL]: ["claude-fable-5", "jev-1.13", "jev-1.13-free"] });

    const models = await buildModelsList(["systemone"]);
    const jev = models.filter((m) => m.provider?.id === "opencode-zen");

    expect(jev.map((m) => m.id)).toEqual(["opencode-zen/jev-1.13", "opencode-zen/jev-1.13-free"]);
    expect(jev[0].aliases).toEqual(["ocz/jev-1.13"]);
    expect(jev[0].provider).toMatchObject({
      id: "opencode-zen",
      name: "OpenCode Zen",
      via: { id: "opencode-go", name: "OpenCode Go" },
      connection: { id: goConnection.id },
    });
  });

  it("falls back to the built-in JEV models when Zen's list cannot be fetched", async () => {
    stubOpenCode({});

    const ids = (await buildModelsList(["systemone"])).map((m) => m.id);

    expect(ids).toEqual(expect.arrayContaining(["opencode-zen/jev-1.13", "opencode-zen/jev-1.13-free"]));
  });

  it("keeps JEV out of the chat list", async () => {
    stubOpenCode({ [ZEN_MODELS_URL]: ["jev-1.13", "jev-1.13-free"], [GO_MODELS_URL]: ["glm-5.3"] });

    const ids = (await buildModelsList(["llm"])).map((m) => m.id);

    expect(ids.some((id) => /jev/.test(id))).toBe(false);
  });
});

describe("/v1/models with the live OpenCode Go list", () => {
  it("adds Go models newer than the built-in list", async () => {
    stubOpenCode({ [GO_MODELS_URL]: ["glm-5.3", "gpt-6-luna", "omen-alpha"] });

    const goModels = (await buildModelsList(["llm"])).filter((m) => m.provider?.id === "opencode-go");

    expect(goModels.map((m) => m.id)).toEqual(["opencode-go/glm-5.3", "opencode-go/gpt-6-luna", "opencode-go/omen-alpha"]);
    // Built-in metadata stays; new models get a name and limits.
    expect(goModels[0].name).toBe("GLM 5.3");
    expect(goModels[1].name).toBeTruthy();
    expect(goModels[2].context_length).toBeGreaterThan(0);
  });

  it("serves the built-in list when the live one cannot be fetched", async () => {
    stubOpenCode({});
    const { PROVIDER_MODELS } = await import("../../open-sse/config/providerModels.js");

    const goIds = (await buildModelsList(["llm"])).filter((m) => m.provider?.id === "opencode-go").map((m) => m.id);

    expect(goIds).toEqual(PROVIDER_MODELS["opencode-go"].map((m) => `opencode-go/${m.id}`));
  });
});
