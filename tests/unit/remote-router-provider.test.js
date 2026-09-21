import { describe, expect, it } from "vitest";
import { BaseExecutor } from "open-sse/executors/base.js";
import {
  RED_ROUTER_CHAIN_HEADER,
  RED_ROUTER_INSTANCE_ID,
  RED_ROUTER_MAX_HOPS,
  appendRedRouterHop,
  normalizeRedRouterBaseUrl,
  redRouterEndpoint,
} from "open-sse/config/redRouter.js";
import { normalizeProviderSpecificData } from "@/lib/providerNormalization.js";
import { APIKEY_PROVIDERS } from "@/shared/constants/providers.js";

describe("RedRouter provider", () => {
  it.each([
    ["https://router.example.com", "https://router.example.com/v1"],
    ["https://router.example.com/", "https://router.example.com/v1"],
    ["https://router.example.com/v1", "https://router.example.com/v1"],
    ["https://router.example.com/api/v1", "https://router.example.com/api/v1"],
    ["https://router.example.com/v1/chat/completions", "https://router.example.com/v1"],
    ["https://router.example.com/api/v1/models", "https://router.example.com/api/v1"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeRedRouterBaseUrl(input)).toBe(expected);
  });

  it("builds remote endpoints and normalizes persisted provider data", () => {
    expect(redRouterEndpoint("http://10.0.0.5:25050", "models"))
      .toBe("http://10.0.0.5:25050/v1/models");
    expect(normalizeProviderSpecificData("red-router", {}, { baseUrl: "http://10.0.0.5:25050/" }))
      .toEqual({ baseUrl: "http://10.0.0.5:25050/v1" });
  });

  it("is a first-class API-key provider", () => {
    expect(APIKEY_PROVIDERS["red-router"]).toMatchObject({
      id: "red-router",
      name: "RedRouter",
      passthroughModels: true,
    });
  });

  it("routes chat requests to the configured remote RedRouter", () => {
    const executor = new BaseExecutor("red-router", {});
    const credentials = {
      apiKey: "rr_test",
      providerSpecificData: { baseUrl: "https://router.example.com" },
      rawHeaders: {},
    };
    expect(executor.buildUrl("openrouter/anthropic/claude-sonnet-4.6", true, 0, credentials))
      .toBe("https://router.example.com/v1/chat/completions");
    expect(executor.buildHeaders(credentials)).toMatchObject({
      Authorization: "Bearer rr_test",
      [RED_ROUTER_CHAIN_HEADER]: expect.any(String),
    });
  });

  it("detects A -> B -> A loops and enforces a hop ceiling", () => {
    expect(appendRedRouterHop("router-a", "router-b")).toBe("router-a,router-b");
    expect(() => appendRedRouterHop("router-a,router-b", "router-a"))
      .toThrow("routing loop detected");
    const fullChain = Array.from({ length: RED_ROUTER_MAX_HOPS }, (_, index) => `router-${index}`).join(",");
    expect(() => appendRedRouterHop(fullChain, "router-next"))
      .toThrow("hop limit exceeded");

    const executor = new BaseExecutor("red-router", {});
    expect(() => executor.buildHeaders({
      apiKey: "rr_test",
      rawHeaders: { [RED_ROUTER_CHAIN_HEADER]: RED_ROUTER_INSTANCE_ID },
    })).toThrow("routing loop detected");
  });
});
