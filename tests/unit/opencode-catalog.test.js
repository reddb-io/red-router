// Live OpenCode catalogs: the Go model list and Zen's System One (JEV) models.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureOpenCodeGoModel,
  resetOpenCodeCatalogs,
  resolveOpenCodeGoModels,
  resolveOpenCodeZenSystemOneModels,
} from "../../open-sse/services/opencodeCatalog.js";
import {
  OPENCODE_CATALOG_RETRY_MS,
  OPENCODE_CATALOG_TTL_MS,
  OPENCODE_GO_MODELS_URL,
  OPENCODE_ZEN_MODELS_URL,
} from "../../open-sse/config/opencodeCatalog.js";
import { getModelSupportedFormats, getModelTargetFormat, getProviderModels } from "../../open-sse/config/providerModels.js";
import { resolveSystemOneProviderModel } from "../../open-sse/handlers/systemOneCore.js";
import { getExecutor } from "../../open-sse/executors/index.js";

const NOW = 1_800_000_000_000;

function listResponse(ids) {
  return Response.json({ object: "list", data: ids.map((id) => ({ id, object: "model", owned_by: "opencode" })) });
}

function catalogFetch(lists) {
  return vi.fn(async (url) => {
    const ids = lists[url];
    if (!ids) throw new Error(`unexpected fetch ${url}`);
    return listResponse(ids);
  });
}

// models.dev browse entries (browseShape keys): n = name, a = serving SDK.
const MODELS_DEV = {
  "grok-4.7": { n: "Grok 4.7", a: "@ai-sdk/openai", c: 500000, o: 500000 },
  "mimo-v2.6-pro": { n: "MiMo-V2.6-Pro" },
  "qwen3.9-max": { n: "Qwen3.9 Max", a: "@ai-sdk/anthropic" },
};

beforeEach(() => resetOpenCodeCatalogs());

describe("OpenCode Go live catalog", () => {
  it("lists the live ids, keeping built-in metadata and describing new models from models.dev", async () => {
    const fetchImpl = catalogFetch({
      [OPENCODE_GO_MODELS_URL]: ["glm-5.3", "grok-4.6", "grok-4.7", "mimo-v2.6-pro", "qwen3.9-max", "omen-alpha"],
    });

    const { models, source } = await resolveOpenCodeGoModels({ modelsDev: MODELS_DEV, fetchImpl, now: NOW });

    expect(source).toBe("live");
    expect(fetchImpl).toHaveBeenCalledWith(OPENCODE_GO_MODELS_URL, expect.any(Object));
    expect(models.map((m) => m.id)).toEqual(["glm-5.3", "grok-4.6", "grok-4.7", "mimo-v2.6-pro", "qwen3.9-max", "omen-alpha"]);
    // Built-in entries are kept as they are.
    const builtIn = getProviderModels("opencode-go");
    expect(models[0]).toBe(builtIn.find((m) => m.id === "glm-5.3"));
    expect(models[1]).toBe(builtIn.find((m) => m.id === "grok-4.6"));
    // New ones: models.dev name and endpoint, else a derived name and /chat/completions.
    expect(models[2]).toMatchObject({ id: "grok-4.7", name: "Grok 4.7", targetFormat: "openai-responses", supportedFormats: ["openai-responses"] });
    expect(models[3]).toMatchObject({ id: "mimo-v2.6-pro", name: "MiMo-V2.6-Pro", supportedFormats: ["openai"] });
    expect(models[4]).toMatchObject({ id: "qwen3.9-max", supportedFormats: ["openai", "claude"] });
    expect(models[5]).toMatchObject({ id: "omen-alpha", supportedFormats: ["openai"] });
    expect(models[5].name).toBeTruthy();
  });

  it("drops built-in ids the live list no longer has", async () => {
    const fetchImpl = catalogFetch({ [OPENCODE_GO_MODELS_URL]: ["glm-5.3"] });
    const { models } = await resolveOpenCodeGoModels({ fetchImpl, now: NOW });
    expect(models.map((m) => m.id)).toEqual(["glm-5.3"]);
  });

  it("routes new models to the endpoint they are served on", async () => {
    const fetchImpl = catalogFetch({ [OPENCODE_GO_MODELS_URL]: ["grok-4.7", "omen-alpha"] });
    expect(getModelTargetFormat("opencode-go", "grok-4.7")).toBeNull();

    await resolveOpenCodeGoModels({ modelsDev: MODELS_DEV, fetchImpl, now: NOW });

    expect(getModelTargetFormat("opencode-go", "grok-4.7")).toBe("openai-responses");
    expect(getModelTargetFormat("opencode-go", "grok-4.7(high)")).toBe("openai-responses");
    expect(getModelSupportedFormats("opencode-go", "omen-alpha")).toEqual(["openai"]);
    const executor = getExecutor("opencode-go");
    expect(executor.buildUrl("grok-4.7", true)).toBe("https://opencode.ai/zen/go/v1/responses");
    expect(executor.buildUrl("omen-alpha", true)).toBe("https://opencode.ai/zen/go/v1/chat/completions");
    // The built-in list itself is untouched.
    expect(getProviderModels("opencode-go").some((m) => m.id === "grok-4.7")).toBe(false);
  });

  it("falls back to the built-in list when OpenCode cannot be reached", async () => {
    const offline = vi.fn(async () => { throw new Error("offline"); });
    const failed = await resolveOpenCodeGoModels({ fetchImpl: offline, now: NOW });
    expect(failed.source).toBe("builtin");
    expect(failed.models).toEqual(getProviderModels("opencode-go"));

    resetOpenCodeCatalogs();
    const serverError = vi.fn(async () => new Response("down", { status: 503 }));
    const errored = await resolveOpenCodeGoModels({ fetchImpl: serverError, now: NOW });
    expect(errored.source).toBe("builtin");
    expect(errored.models).toEqual(getProviderModels("opencode-go"));
  });

  it("serves the cached list for the TTL, then refetches", async () => {
    const fetchImpl = catalogFetch({ [OPENCODE_GO_MODELS_URL]: ["glm-5.3", "grok-4.7"] });

    await resolveOpenCodeGoModels({ fetchImpl, now: NOW });
    await resolveOpenCodeGoModels({ fetchImpl, now: NOW + OPENCODE_CATALOG_TTL_MS - 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await resolveOpenCodeGoModels({ fetchImpl, now: NOW + OPENCODE_CATALOG_TTL_MS });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keeps the last good list through a failed refresh and waits before retrying", async () => {
    const good = catalogFetch({ [OPENCODE_GO_MODELS_URL]: ["glm-5.3", "grok-4.7"] });
    await resolveOpenCodeGoModels({ fetchImpl: good, now: NOW });

    const offline = vi.fn(async () => { throw new Error("offline"); });
    const stale = NOW + OPENCODE_CATALOG_TTL_MS;
    const kept = await resolveOpenCodeGoModels({ fetchImpl: offline, now: stale });
    expect(kept.source).toBe("live");
    expect(kept.models.map((m) => m.id)).toEqual(["glm-5.3", "grok-4.7"]);

    await resolveOpenCodeGoModels({ fetchImpl: offline, now: stale + OPENCODE_CATALOG_RETRY_MS - 1 });
    expect(offline).toHaveBeenCalledTimes(1);
    await resolveOpenCodeGoModels({ fetchImpl: offline, now: stale + OPENCODE_CATALOG_RETRY_MS });
    expect(offline).toHaveBeenCalledTimes(2);
  });

  it("shares one fetch between concurrent callers", async () => {
    const fetchImpl = catalogFetch({ [OPENCODE_GO_MODELS_URL]: ["glm-5.3"] });
    await Promise.all([
      resolveOpenCodeGoModels({ fetchImpl, now: NOW }),
      resolveOpenCodeGoModels({ fetchImpl, now: NOW }),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("only waits for the live list when routing meets an unknown model", async () => {
    const fetchImpl = catalogFetch({ [OPENCODE_GO_MODELS_URL]: ["glm-5.3", "grok-4.7"] });
    const modelsDev = vi.fn(() => MODELS_DEV);

    await ensureOpenCodeGoModel("glm-5.3(high)", { fetchImpl, modelsDev, now: NOW });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(modelsDev).not.toHaveBeenCalled();

    await ensureOpenCodeGoModel("grok-4.7", { fetchImpl, modelsDev, now: NOW });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(getModelTargetFormat("opencode-go", "grok-4.7")).toBe("openai-responses");
  });
});

describe("OpenCode Zen System One catalog", () => {
  it("offers the JEV ids of the live Zen list", async () => {
    const fetchImpl = catalogFetch({
      [OPENCODE_ZEN_MODELS_URL]: ["claude-fable-5", "jev-1.13", "jev-1.13-free", "jev-2.0", "gpt-6"],
    });

    const { models, source } = await resolveOpenCodeZenSystemOneModels({ fetchImpl, now: NOW });

    expect(source).toBe("live");
    expect(models.map((m) => m.id)).toEqual(["jev-1.13", "jev-1.13-free", "jev-2.0"]);
    expect(models.every((m) => m.kind === "systemone")).toBe(true);
    // A new JEV id is served as asked instead of falling back to the free default.
    expect(resolveSystemOneProviderModel("opencode-zen", "opencode-zen/jev-2.0")).toBe("jev-2.0");
  });

  it("falls back to the built-in JEV models when Zen cannot be reached", async () => {
    const offline = vi.fn(async () => { throw new Error("offline"); });
    const { models, source } = await resolveOpenCodeZenSystemOneModels({ fetchImpl: offline, now: NOW });
    expect(source).toBe("builtin");
    expect(models.map((m) => m.id)).toEqual(["jev-1.13", "jev-1.13-free"]);
  });

  it("serves each listed JEV model as asked, and unknown ones on the free default", () => {
    expect(resolveSystemOneProviderModel("opencode-zen", "opencode-zen/jev-1.13")).toBe("jev-1.13");
    expect(resolveSystemOneProviderModel("opencode-zen", "ocz/jev-1.13-free")).toBe("jev-1.13-free");
    expect(resolveSystemOneProviderModel("opencode-zen", "jev-latest")).toBe("jev-1.13-free");
    expect(resolveSystemOneProviderModel("opencode-zen", "jev-2.0")).toBe("jev-1.13-free");
  });
});
