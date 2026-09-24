import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;

describe("RedRouter provider API", () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "red-router-upstream-provider-"));
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
    vi.doMock("next/server", () => ({
      NextResponse: {
        json(body, init = {}) {
          return new Response(JSON.stringify(body), {
            status: init.status || 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      },
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock("next/server");
    vi.resetModules();
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("stores a remote router, validates it, and discovers its models", async () => {
    const remoteModels = {
      object: "list",
      data: [{ id: "openrouter/anthropic/claude-sonnet-4.6", object: "model" }],
    };
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify(remoteModels), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);


    const { POST: createConnection } = await import("@/app/api/providers/route.js");
    const createResponse = await createConnection(new Request("https://local.test/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "red-router",
        name: "Office Router",
        apiKey: "rr_remote_key",
        providerSpecificData: { baseUrl: "https://remote-router.test/" },
      }),
    }));
    const created = await createResponse.json();

    expect(createResponse.status).toBe(201);
    expect(created.connection).toMatchObject({
      provider: "red-router",
      name: "Office Router",
      providerSpecificData: { baseUrl: "https://remote-router.test/v1" },
    });


    const { POST: validateConnection } = await import("@/app/api/providers/validate/route.js");
    const validationResponse = await validateConnection(new Request("https://local.test/api/providers/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "red-router",
        apiKey: "rr_remote_key",
        providerSpecificData: { baseUrl: "https://remote-router.test" },
      }),
    }));
    expect(await validationResponse.json()).toEqual({ valid: true, error: null });

    const { GET: getModels } = await import("@/app/api/providers/[id]/models/route.js");
    const modelsResponse = await getModels(
      new Request("https://local.test/api/providers/models"),
      { params: Promise.resolve({ id: created.connection.id }) },
    );
    const models = await modelsResponse.json();

    expect(modelsResponse.status).toBe(200);
    expect(models.models).toEqual(remoteModels.data);
    const { GET: getLocalCatalog } = await import("@/app/api/models/route.js");
    const localCatalog = await (await getLocalCatalog()).json();
    expect(localCatalog.models).toContainEqual(expect.objectContaining({
      fullModel: "red-router/openrouter/anthropic/claude-sonnet-4.6",
    }));
    const { buildModelsList } = await import("@/app/api/v1/models/route.js");
    expect(await buildModelsList(["llm"])).toContainEqual(expect.objectContaining({
      id: "red-router/openrouter/anthropic/claude-sonnet-4.6",
    }));
    const { getProviderConnectionById } = await import("@/models");
    expect((await getProviderConnectionById(created.connection.id)).providerSpecificData.discoveredModels).toEqual(remoteModels.data);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://remote-router.test/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer rr_remote_key" }),
      }),
    );

    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ data: [{ id: "cc/new-access" }] })));
    const { PUT: updateConnection } = await import("@/app/api/providers/[id]/route.js");
    const updateResponse = await updateConnection(new Request("https://local.test/api/providers/remote", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "replacement-key" }),
    }), { params: Promise.resolve({ id: created.connection.id }) });
    expect(updateResponse.status).toBe(200);
    expect((await getProviderConnectionById(created.connection.id)).providerSpecificData.discoveredModels)
      .toEqual([{ id: "cc/new-access" }]);
    expect(fetchMock).toHaveBeenLastCalledWith("https://remote-router.test/v1/models", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer replacement-key" }),
    }));
  });

  it("moves a remote router to a new URL when its endpoint is edited", async () => {
    const fetchMock = vi.fn(async (url) => new Response(JSON.stringify({
      data: [{ id: String(url).includes("moved-router") ? "moved/model" : "first/model" }],
    })));
    vi.stubGlobal("fetch", fetchMock);
    const { POST: createConnection } = await import("@/app/api/providers/route.js");
    const created = await (await createConnection(new Request("https://local.test/api/providers", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "red-router", name: "Office", apiKey: "rr_key", providerSpecificData: { baseUrl: "https://first-router.test" } }),
    }))).json();
    const { PUT: updateConnection } = await import("@/app/api/providers/[id]/route.js");
    const put = (providerSpecificData) => updateConnection(new Request("https://local.test/api/providers/x", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerSpecificData }),
    }), { params: Promise.resolve({ id: created.connection.id }) });

    const moved = await put({ baseUrl: " https://moved-router.test/ " });
    expect(moved.status).toBe(200);
    const { getProviderConnectionById } = await import("@/models");
    const stored = (await getProviderConnectionById(created.connection.id)).providerSpecificData;
    expect(stored.baseUrl).toBe("https://moved-router.test/v1");
    expect(stored.discoveredModels).toEqual([{ id: "moved/model" }]);
    expect(fetchMock).toHaveBeenLastCalledWith("https://moved-router.test/v1/models", expect.anything());

    for (const baseUrl of ["not a url", "ftp://moved-router.test"]) {
      const rejected = await put({ baseUrl });
      expect(rejected.status, baseUrl).toBe(400);
    }
    expect((await getProviderConnectionById(created.connection.id)).providerSpecificData.baseUrl).toBe("https://moved-router.test/v1");
  });

  it("tests an edited URL as typed, without saving its result", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => (String(url).includes("wrong-router")
      ? new Response("Not Found", { status: 404 })
      : new Response(JSON.stringify({ data: [{ id: "first/model" }] })))));
    const { POST: createConnection } = await import("@/app/api/providers/route.js");
    const created = await (await createConnection(new Request("https://local.test/api/providers", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "red-router", name: "Office", apiKey: "rr_key", providerSpecificData: { baseUrl: "https://first-router.test" } }),
    }))).json();
    const { POST: testConnection } = await import("@/app/api/providers/[id]/test/route.js");
    const test = async (body) => (await testConnection(new Request("https://local.test/api/providers/x/test", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }), { params: Promise.resolve({ id: created.connection.id }) })).json();

    expect((await test({})).valid).toBe(true);

    const wrong = await test({ providerSpecificData: { baseUrl: "https://wrong-router.test" } });
    expect(wrong.valid).toBe(false);
    expect(wrong.error).toBeTruthy();
    const malformed = await test({ providerSpecificData: { baseUrl: "definitely not a url" } });
    expect(malformed).toMatchObject({ valid: false, error: "A valid remote RedRouter URL is required" });

    const { getProviderConnectionById } = await import("@/models");
    const stored = await getProviderConnectionById(created.connection.id);
    expect(stored.providerSpecificData.baseUrl).toBe("https://first-router.test/v1");
    expect(stored.testStatus).toBe("active");
  });

  it("reports discovery failure without saving a partially configured connection", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Unauthorized", { status: 401 })));
    const { POST } = await import("@/app/api/providers/route.js");
    const { getProviderConnections } = await import("@/models");
    const before = await getProviderConnections();
    const response = await POST(new Request("https://local.test/api/providers", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "red-router", name: "Remote", apiKey: "bad-key", providerSpecificData: { baseUrl: "https://remote.test" } }),
    }));
    expect(response.status).toBe(502);
    expect((await response.json()).error).toContain("401");
    expect(await getProviderConnections()).toEqual(before);
  });

  it("rejects a missing remote URL", async () => {
    const { POST } = await import("@/app/api/providers/route.js");
    const response = await POST(new Request("https://local.test/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "red-router",
        name: "Broken Router",
        apiKey: "rr_remote_key",
      }),
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "A valid remote RedRouter URL is required" });
  });
});
