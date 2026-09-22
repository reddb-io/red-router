import http from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/models", () => ({ getProviderConnectionById: vi.fn(), updateProviderConnection: vi.fn() }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: async () => ({}) }));
const { syncRemoteRouterCatalog } = await import("@/lib/remoteRouterCatalog");
const { parseModel } = await import("open-sse/services/model.js");
const { BaseExecutor } = await import("open-sse/executors/base.js");

let server;
let baseUrl;
const requests = [];
const remoteModels = [{ id: "cc/claude-fable-5.1" }, { id: "openai/example" }, { id: "coding-combo" }];
beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ path: req.url, authorization: req.headers.authorization, body });
    res.setHeader("Content-Type", "application/json");
    if (req.headers.authorization !== "Bearer remote-router-key") {
      res.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
    } else if (req.url === "/v1/models") {
      res.end(JSON.stringify({ object: "list", data: remoteModels }));
    } else if (req.url === "/v1/chat/completions") {
      res.end(JSON.stringify({ model: body.model, choices: [{ message: { role: "assistant", content: "remote reply" } }] }));
    } else res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

describe("RedRouter HTTP discovery and forwarding", () => {
  it("discovers every remote provider and forwards a selected Claude using only the router key", async () => {
    const credentials = { apiKey: "remote-router-key", providerSpecificData: { baseUrl }, rawHeaders: {} };
    const catalog = await syncRemoteRouterCatalog(credentials, { persist: false });
    expect(catalog.models).toEqual(remoteModels);
    const selected = parseModel(`red-router/${catalog.models[0].id}`);
    expect(selected).toMatchObject({ provider: "red-router", model: "cc/claude-fable-5.1" });
    const executor = new BaseExecutor(selected.provider, {});
    const { response } = await executor.execute({
      model: selected.model,
      body: { model: selected.model, messages: [{ role: "user", content: "hello" }], stream: false },
      stream: false, credentials,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ model: "cc/claude-fable-5.1", choices: [{ message: { content: "remote reply" } }] });
    expect(requests.map((r) => r.path)).toEqual(["/v1/models", "/v1/chat/completions"]);
    expect(requests.every((r) => r.authorization === "Bearer remote-router-key")).toBe(true);
  });
});
