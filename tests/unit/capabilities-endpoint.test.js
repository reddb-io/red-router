// GET /v1/capabilities advertises what this instance supports, read from live config.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
const originalInstanceId = process.env.RED_ROUTER_INSTANCE_ID;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rr-capabilities-"));
  process.env.DATA_DIR = tempDir;
  delete process.env.RED_ROUTER_INSTANCE_ID;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  await db.createCombo({ name: "coding", models: ["gh/gpt-4o", "gh/gpt-3.5-turbo"] });
  await db.createCombo({ name: "rotating", models: ["gh/gpt-4o", "gh/gpt-3.5-turbo"] });
  await db.updateSettings({
    comboStrategy: "fallback",
    comboStrategies: { rotating: { fallbackStrategy: "round-robin" } },
    decisionRouter: { mode: "shadow", toolMode: "hint", effort: true },
  });
});

afterEach(() => {
  delete process.env.RED_ROUTER_INSTANCE_ID;
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalInstanceId !== undefined) process.env.RED_ROUTER_INSTANCE_ID = originalInstanceId;
});

async function getCapabilities() {
  const { GET } = await import("../../src/app/api/v1/capabilities/route.js");
  const response = await GET(new Request("http://localhost/v1/capabilities"));
  expect(response.status).toBe(200);
  return response.json();
}

describe("GET /v1/capabilities", () => {
  it("identifies the product, version and instance", async () => {
    const caps = await getCapabilities();
    const cliPkg = JSON.parse(fs.readFileSync(new URL("../../cli/package.json", import.meta.url), "utf8"));
    expect(caps.product).toBe("red-router");
    expect(caps.version).toBe(cliPkg.version);
    expect(caps.instance_id).toMatch(/^rr_[0-9a-f]{16}$/);
    // Stable across calls.
    expect((await getCapabilities()).instance_id).toBe(caps.instance_id);
  });

  it("honors RED_ROUTER_INSTANCE_ID", async () => {
    process.env.RED_ROUTER_INSTANCE_ID = "edge-1";
    expect((await getCapabilities()).instance_id).toBe("edge-1");
  });

  it("reports decision routing from settings and the fixed headers", async () => {
    const caps = await getCapabilities();
    expect(caps.decision).toEqual({
      mode: "shadow",
      tool_mode: "hint",
      effort: true,
      header: "x-red-router-decision",
      accepts_hint: true,
      hint_header: "x-red-router-hint",
      hint_keys: ["complexity", "deliberation", "needs_tool", "tier"],
      off_keeps_hinted_model: true,
    });
    expect(caps.token_saver_header).toBe("x-red-router-token-saver");
    expect(caps.combos.strategies).toEqual(["fallback", "round-robin", "fusion", "smart", "auto"]);
    expect(caps.session.per_session_stickiness).toBe(true);
    expect(caps.session.prompt_cache_key).toBe(true);
    expect(caps.session.affinity_headers).toEqual(["x-parent-session-id", "x-session-affinity"]);
    expect(caps.session.affinity_ttl_ms).toBe(30 * 60 * 1000);
    expect(caps.session.headers).toEqual(expect.arrayContaining(["x-session-id", "x-claude-code-session-id"]));
    const headers = caps.session.headers;
    expect(headers.indexOf("x-session-affinity")).toBe(headers.indexOf("x-session-id") + 1);
    expect(headers.indexOf("x-parent-session-id")).toBe(headers.indexOf("x-session-id") + 2);
    expect(caps.served_model_header).toBe("X-RedRouter-Served-Model");
    expect(caps.cost_header).toBe("X-RedRouter-Cost-USD");
    expect(caps.request_id_header).toBe("X-Request-Id");
    expect(caps.stream_usage_cost).toBe(true);
  });

  // redcode (packages/core/src/provider/router.ts fromCapabilities) turns these into
  // features; each must keep its name and type.
  it("exposes every field redcode reads, with the types it checks", async () => {
    const caps = await getCapabilities();
    expect(caps.product).toBe("red-router");
    expect(typeof caps.version).toBe("string");
    expect(typeof caps.instance_id).toBe("string");
    expect(typeof caps.systemone.available).toBe("boolean");
    expect(Array.isArray(caps.systemone.models)).toBe(true);
    expect(Array.isArray(caps.combos.strategies)).toBe(true);
    expect(typeof caps.decision.header).toBe("string");
    expect(caps.decision.accepts_hint).toBe(true);
    expect(typeof caps.token_saver_header).toBe("string");
    expect(caps.session.per_session_stickiness === true || Array.isArray(caps.session.affinity_headers)).toBe(true);
    expect(typeof caps.served_model_header).toBe("string");
    expect(typeof caps.cost_header).toBe("string");
    expect(caps.stream_usage_cost).toBe(true);
  });

  it("marks System One unavailable without an account, available with one", async () => {
    const before = await getCapabilities();
    expect(before.systemone).toEqual({ endpoint: "/v1/systemone", available: false, models: [] });

    await db.createProviderConnection({ provider: "typesafe-ai", authType: "apikey", name: "jev", apiKey: "k-jev" });
    const after = await getCapabilities();
    expect(after.systemone.available).toBe(true);
    // Same ids as /v1/models/systemone (provider display alias + model).
    expect(after.systemone.models.some((id) => id.endsWith("/jev-latest"))).toBe(true);
  });
});

describe("/v1/models combo strategy", () => {
  it("labels each combo with the strategy it runs", async () => {
    const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");
    const combos = (await buildModelsList(["llm"])).filter((m) => m.owned_by === "combo");
    expect(combos.find((m) => m.id === "coding").strategy).toBe("fallback");
    expect(combos.find((m) => m.id === "rotating").strategy).toBe("round-robin");
  });
});
