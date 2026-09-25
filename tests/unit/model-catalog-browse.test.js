import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The browse file path comes from DATA_DIR at import time.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rr-browse-"));
process.env.DATA_DIR = dataDir;
const browseFile = path.join(dataDir, "model-catalog-browse.json");
const openrouterFile = path.join(dataDir, "model-catalog-openrouter.json");

// models.dev-shaped upstream: one direct provider, one aliased, one gateway.
const upstream = {
  anthropic: {
    name: "Anthropic",
    models: {
      "claude-new": {
        name: "Claude New", family: "claude", release_date: "2026-08-01", reasoning: true, tool_call: true,
        modalities: { input: ["text", "image", "pdf"], output: ["text"] }, limit: { context: 1_000_000, output: 128_000 },
        cost: { input: 3, output: 15 },
      },
      "claude-old": {
        name: "Claude Old", release_date: "2024-01-01", tool_call: true,
        modalities: { input: ["text"], output: ["text"] }, limit: { context: 200_000 }, cost: { input: 1, output: 5 },
      },
    },
  },
  openrouter: {
    name: "OpenRouter",
    models: {
      "qwen/qwen-next": { name: "Qwen Next", family: "qwen", release_date: "2026-07-10", open_weights: true, knowledge: "2026-03" },
    },
  },
  opencode: {
    name: "OpenCode Zen",
    models: {
      "big-pickle": { name: "Big Pickle", cost: { input: 0, output: 0 }, modalities: { input: ["text"], output: ["text"] } },
      "paid-one": { name: "Paid", cost: { input: 2, output: 8 }, modalities: { input: ["text"], output: ["text"] } },
      "image-gen": { name: "Imager", cost: { input: 0, output: 0 }, modalities: { input: ["text"], output: ["image"] } },
    },
  },
};

let browseSlim, getProviderCatalog, modelsDevProviderId, resetBrowseCatalog;
let resetOpenCodeCatalogs, resolveOpenCodeZenSystemOneModels, getProviderModels, PROVIDER_ID_TO_ALIAS;

beforeAll(async () => {
  ({ browseSlim } = await import("../../src/lib/modelCatalog/browseShape.js"));
  ({ getProviderCatalog, modelsDevProviderId, resetBrowseCatalog } = await import("../../src/lib/modelCatalog/browse.js"));
  ({ resetOpenCodeCatalogs, resolveOpenCodeZenSystemOneModels } = await import("../../open-sse/services/opencodeCatalog.js"));
  ({ getProviderModels, PROVIDER_ID_TO_ALIAS } = await import("../../open-sse/config/providerModels.js"));
  fs.writeFileSync(browseFile, JSON.stringify(browseSlim(upstream)));
});

// A restart: nothing cached in memory, whatever is on disk stays.
beforeEach(() => {
  resetBrowseCatalog();
  resetOpenCodeCatalogs();
});

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe("browseSlim", () => {
  it("keeps what the browser filters on, under short keys", () => {
    const slim = browseSlim(upstream);
    expect(slim.anthropic.n).toBe("Anthropic");
    expect(slim.anthropic.m["claude-new"]).toMatchObject({
      n: "Claude New", f: "claude", d: "2026-08-01", r: true, t: true, i: ["image", "pdf"], c: 1_000_000, o: 128_000, ci: 3, co: 15,
    });
    expect(slim.opencode.m["image-gen"].nt).toBe(true);
    expect(slim.opencode.m["big-pickle"].nt).toBeUndefined();
  });
});

describe("modelsDevProviderId", () => {
  it("maps our ids to models.dev's, and leaves matching ids alone", () => {
    expect(modelsDevProviderId("claude")).toBe("anthropic");
    expect(modelsDevProviderId("github")).toBe("github-copilot");
    expect(modelsDevProviderId("vercel-ai-gateway")).toBe("vercel");
    expect(modelsDevProviderId("ollama")).toBe("ollama-cloud");
    expect(modelsDevProviderId("groq")).toBe("groq");
    // subscription CLIs serve a subset under their own names: never mapped
    expect(modelsDevProviderId("codex")).toBe("codex");
  });
});

describe("getProviderCatalog", () => {
  it("normalizes a models.dev provider, newest first", async () => {
    const { source, models } = await getProviderCatalog("claude");
    expect(source).toBe("models.dev");
    expect(models.map((m) => m.id)).toEqual(["claude-new", "claude-old"]);
    expect(models[0]).toMatchObject({
      name: "Claude New", vendor: "Anthropic", releaseDate: "2026-08-01", contextWindow: 1_000_000, maxOutput: 128_000,
      reasoning: true, tools: true, vision: true, pdf: true, audio: false, free: false, textOutput: true,
      cost: { input: 3, output: 15 },
    });
  });

  it("returns an empty list for a provider models.dev does not know", async () => {
    expect(await getProviderCatalog("mimo-free")).toEqual({ provider: "mimo-free", source: null, fetchedAt: null, models: [] });
  });

  it("serves only the free slice to OpenCode Free", async () => {
    const { models } = await getProviderCatalog("opencode");
    expect(models.map((m) => m.id).sort()).toEqual(["big-pickle", "image-gen"]);
    expect(models.find((m) => m.id === "image-gen").textOutput).toBe(false);
  });

  it("lists OpenRouter from its live API and completes it with models.dev", async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      return jsonResponse({
        data: [
          {
            id: "qwen/qwen-next", name: "Qwen: Qwen Next", created: 1_780_000_000, context_length: 262_144,
            pricing: { prompt: "0.0000002", completion: "0.0000008" },
            supported_parameters: ["tools", "reasoning"], architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
            top_provider: { max_completion_tokens: 32_768 },
          },
          {
            id: "meta/llama-free:free", name: "Llama Free", created: 1_700_000_000, context_length: 131_072,
            pricing: { prompt: "0", completion: "0" }, supported_parameters: [], architecture: { input_modalities: ["text"], output_modalities: ["text"] },
          },
          {
            id: "typesafe/jev-1.13", name: "TypeSafe: Jev 1.13", created: 1_789_689_684, context_length: 32_000,
            pricing: { prompt: "0.000000042", completion: "0" }, supported_parameters: [], architecture: { input_modalities: ["text"], output_modalities: ["decisions"] },
          },
        ],
      });
    };
    const { source, models } = await getProviderCatalog("openrouter", { fetchImpl });
    expect(source).toBe("openrouter+models.dev");
    // Every output modality, or OpenRouter leaves out image, audio and decision models.
    expect(calls).toEqual(["https://openrouter.ai/api/v1/models?output_modalities=all"]);
    const qwen = models.find((m) => m.id === "qwen/qwen-next");
    expect(qwen).toMatchObject({
      vendor: "qwen", contextWindow: 262_144, maxOutput: 32_768, reasoning: true, tools: true, vision: true,
      cost: { input: 0.2, output: 0.8 }, free: false,
      // from models.dev
      family: "qwen", releaseDate: "2026-07-10", openWeights: true, knowledge: "2026-03",
    });
    expect(models.find((m) => m.id === "meta/llama-free:free")).toMatchObject({ vendor: "meta", free: true, releaseDate: "2023-11-14" });
    expect(models.find((m) => m.id === "typesafe/jev-1.13")).toMatchObject({ vendor: "typesafe", textOutput: false, decision: true });

    // cached: a second read does not refetch
    await getProviderCatalog("openrouter", { fetchImpl });
    expect(calls).toHaveLength(1);
  });

  it("offline, lists the last OpenRouter list it saved", async () => {
    const live = async () => jsonResponse({ data: [{ id: "x/saved-model", name: "Saved", created: 1_780_000_000, architecture: { output_modalities: ["text"] } }] });
    const first = await getProviderCatalog("openrouter", { fetchImpl: live });
    expect(first.source).toBe("openrouter+models.dev");

    resetBrowseCatalog(); // a restart, then no network
    const offline = async () => { throw new Error("offline"); };
    const { source, fetchedAt, models } = await getProviderCatalog("openrouter", { fetchImpl: offline });
    expect(source).toBe("openrouter-saved+models.dev");
    expect(fetchedAt).toBe(first.fetchedAt);
    expect(models.map((m) => m.id)).toEqual(["x/saved-model"]);
  });

  it("offline with nothing saved, lists the OpenRouter snapshot shipped with RedRouter", async () => {
    fs.rmSync(openrouterFile, { force: true });
    const offline = async () => { throw new Error("offline"); };
    const { source, fetchedAt, models } = await getProviderCatalog("openrouter", { fetchImpl: offline });
    expect(source).toBe("openrouter-snapshot+models.dev");
    expect(fetchedAt).toBeTruthy();
    // Every output modality is vendored, decision models included.
    expect(models.length).toBeGreaterThan(400);
    expect(models.find((m) => m.id === "typesafe/jev-1.13")).toMatchObject({ decision: true });
  });
});

describe("getProviderCatalog for OpenCode's live lists", () => {
  const ZEN_URL = "https://opencode.ai/zen/v1/models";
  const GO_URL = "https://opencode.ai/zen/go/v1/models";
  const zenFile = path.join(dataDir, "model-catalog-opencode-zen.json");
  const goFile = path.join(dataDir, "model-catalog-opencode-go.json");
  const offline = async () => { throw new Error("offline"); };

  function listFetch(lists, calls = []) {
    return async (url) => {
      calls.push(url);
      if (!lists[url]) throw new Error(`unexpected fetch ${url}`);
      return jsonResponse({ object: "list", data: lists[url].map((id) => ({ id, object: "model", owned_by: "opencode" })) });
    };
  }

  it("lists OpenCode Zen from its live /models, JEV as System One decision models", async () => {
    const calls = [];
    const fetchImpl = listFetch({ [ZEN_URL]: ["big-pickle", "claude-fable-5", "brand-new", "jev-1.13", "jev-1.13-free"] }, calls);
    const { source, fetchedAt, models } = await getProviderCatalog("opencode-zen", { fetchImpl });

    expect(calls).toEqual([ZEN_URL]);
    expect(source).toBe("opencode-zen+models.dev");
    expect(fetchedAt).toBeTruthy();
    // The live list decides what exists: models.dev's "paid-one" is not served today.
    expect(models.map((m) => m.id).sort()).toEqual(["big-pickle", "brand-new", "claude-fable-5", "jev-1.13", "jev-1.13-free"]);
    const byId = Object.fromEntries(models.map((m) => [m.id, m]));
    // models.dev describes what it knows, the built-in registry names the rest.
    expect(byId["big-pickle"]).toMatchObject({ name: "Big Pickle", free: true, textOutput: true });
    expect(byId["big-pickle"].decision).toBeUndefined();
    expect(byId["claude-fable-5"]).toMatchObject({ name: "Claude Fable 5", vendor: "OpenCode Zen", free: false });
    expect(byId["brand-new"]).toMatchObject({ name: "brand-new", free: false });
    expect(byId["jev-1.13"]).toMatchObject({ name: "JEV 1.13", decision: true, textOutput: false, free: false });
    expect(byId["jev-1.13-free"]).toMatchObject({ name: "JEV 1.13 Free", decision: true, textOutput: false, free: true });

    // Saved for the next offline start.
    expect(JSON.parse(fs.readFileSync(zenFile, "utf8"))).toEqual({
      fetchedAt, ids: ["big-pickle", "claude-fable-5", "brand-new", "jev-1.13", "jev-1.13-free"],
    });
  });

  it("reuses the list routing already fetched instead of fetching it again", async () => {
    const calls = [];
    const fetchImpl = listFetch({ [ZEN_URL]: ["big-pickle", "jev-1.13"] }, calls);
    await resolveOpenCodeZenSystemOneModels({ fetchImpl });
    const { models } = await getProviderCatalog("opencode-zen", { fetchImpl });
    expect(calls).toEqual([ZEN_URL]);
    expect(models.map((m) => m.id).sort()).toEqual(["big-pickle", "jev-1.13"]);
  });

  it("offline, lists the last OpenCode Zen list it saved", async () => {
    const first = await getProviderCatalog("opencode-zen", { fetchImpl: listFetch({ [ZEN_URL]: ["saved-one", "jev-1.13"] }) });

    resetBrowseCatalog();
    resetOpenCodeCatalogs();
    const { source, fetchedAt, models } = await getProviderCatalog("opencode-zen", { fetchImpl: offline });
    expect(source).toBe("opencode-zen-saved+models.dev");
    expect(fetchedAt).toBe(first.fetchedAt);
    expect(models.map((m) => m.id).sort()).toEqual(["jev-1.13", "saved-one"]);
    expect(models.find((m) => m.id === "jev-1.13")).toMatchObject({ decision: true });
  });

  it("lists OpenCode Go from its live /models", async () => {
    const calls = [];
    const { source, fetchedAt, models } = await getProviderCatalog("opencode-go", {
      fetchImpl: listFetch({ [GO_URL]: ["kimi-k3", "go-only-new"] }, calls),
    });
    expect(calls).toEqual([GO_URL]);
    // No opencode-go entry in this models.dev fixture: the list alone.
    expect(source).toBe("opencode-go");
    expect(fetchedAt).toBeTruthy();
    expect(models.map((m) => m.id).sort()).toEqual(["go-only-new", "kimi-k3"]);
    expect(fs.existsSync(goFile)).toBe(true);
  });

  it("offline with nothing saved, lists the built-in OpenCode Go models", async () => {
    fs.rmSync(goFile, { force: true });
    const { source, fetchedAt, models } = await getProviderCatalog("opencode-go", { fetchImpl: offline });
    expect(source).toBe("opencode-go-builtin");
    expect(fetchedAt).toBeNull();
    const builtIn = getProviderModels(PROVIDER_ID_TO_ALIAS["opencode-go"] || "opencode-go");
    expect(builtIn.length).toBeGreaterThan(0);
    expect(models.map((m) => m.id).sort()).toEqual(builtIn.map((m) => m.id).sort());
  });
});

describe("catalogSourceLabel", async () => {
  const { catalogSourceLabel, isOfflineCatalog } = await import("../../src/shared/utils/modelBrowser.js");

  it("names each source, and how fresh a provider's own list is", () => {
    expect(catalogSourceLabel("models.dev")).toBe("models.dev");
    expect(catalogSourceLabel("openrouter+models.dev")).toBe("OpenRouter + models.dev");
    expect(catalogSourceLabel("openrouter-snapshot")).toBe("OpenRouter (bundled)");
    expect(catalogSourceLabel("opencode-zen-saved+models.dev")).toBe("OpenCode Zen (saved) + models.dev");
    expect(catalogSourceLabel("opencode-go-builtin")).toBe("OpenCode Go (built-in)");
    expect(catalogSourceLabel("someone-else")).toBe("someone-else");
  });

  it("flags saved and bundled lists as offline copies", () => {
    expect(isOfflineCatalog("openrouter-saved+models.dev")).toBe(true);
    expect(isOfflineCatalog("opencode-zen-saved")).toBe(true);
    expect(isOfflineCatalog("openrouter-snapshot")).toBe(true);
    expect(isOfflineCatalog("opencode-zen+models.dev")).toBe(false);
    expect(isOfflineCatalog("opencode-go-builtin")).toBe(false);
    expect(isOfflineCatalog(null)).toBe(false);
  });
});

describe("filterModels", async () => {
  const {
    filterModels, presetFilters, sortModels, vendorFacets, blendedCost, formatTokens, formatCost, DEFAULT_FILTERS,
  } = await import("../../src/shared/utils/modelBrowser.js");
  const now = Date.parse("2026-09-01T00:00:00Z");
  const models = [
    { id: "a/new-reasoner", name: "New Reasoner", vendor: "a", releaseDate: "2026-08-20", contextWindow: 1_000_000, reasoning: true, tools: true, cost: { input: 3, output: 15 } },
    { id: "a/cheap", name: "Cheap", vendor: "a", releaseDate: "2026-03-01", contextWindow: 128_000, tools: true, cost: { input: 0.1, output: 0.4 } },
    { id: "b/free-open", name: "Free Open", vendor: "b", releaseDate: "2025-06-01", contextWindow: 32_000, free: true, openWeights: true, cost: { input: 0, output: 0 } },
    { id: "b/unknown", name: "Unknown", vendor: "b", contextWindow: 8_000 },
    { id: "c/imager", name: "Imager", vendor: "c", releaseDate: "2026-08-30", textOutput: false },
  ];
  const ids = (list) => list.map((m) => m.id);

  it("hides models that do not produce text, but keeps decision models findable", () => {
    expect(ids(filterModels(models, DEFAULT_FILTERS, { now }))).not.toContain("c/imager");
    expect(vendorFacets(models).map((v) => v.vendor)).not.toContain("c");
    const withDecider = [...models, { id: "d/decider", name: "Decider", vendor: "d", releaseDate: "2026-08-25", textOutput: false, decision: true }];
    expect(ids(filterModels(withDecider, DEFAULT_FILTERS, { now }))).toContain("d/decider");
    expect(vendorFacets(withDecider).map((v) => v.vendor)).toContain("d");
  });

  it("filters by query terms across id, name and owner", () => {
    expect(ids(filterModels(models, { query: "free b" }, { now }))).toEqual(["b/free-open"]);
    expect(ids(filterModels(models, { query: "REASONER" }, { now }))).toEqual(["a/new-reasoner"]);
  });

  it("filters by owner, context, release window and capabilities", () => {
    expect(ids(filterModels(models, { vendor: "b", sort: "name" }, { now }))).toEqual(["b/free-open", "b/unknown"]);
    expect(ids(filterModels(models, { minContext: 128_000 }, { now }))).toEqual(["a/new-reasoner", "a/cheap"]);
    expect(ids(filterModels(models, { releasedWithinDays: 30 }, { now }))).toEqual(["a/new-reasoner"]);
    expect(ids(filterModels(models, { flags: { reasoning: true } }, { now }))).toEqual(["a/new-reasoner"]);
    expect(ids(filterModels(models, { flags: { free: true, openWeights: true } }, { now }))).toEqual(["b/free-open"]);
    expect(ids(filterModels(models, { flags: { reasoning: false } }, { now }))).toHaveLength(4);
  });

  it("sorts newest, by context, by name, and cheapest with unknown prices last", () => {
    const text = models.filter((m) => m.textOutput !== false);
    expect(ids(sortModels(text, "newest"))).toEqual(["a/new-reasoner", "a/cheap", "b/free-open", "b/unknown"]);
    expect(ids(sortModels(text, "context"))).toEqual(["a/new-reasoner", "a/cheap", "b/free-open", "b/unknown"]);
    expect(ids(sortModels(text, "cheapest"))).toEqual(["b/free-open", "a/cheap", "a/new-reasoner", "b/unknown"]);
    expect(ids(sortModels(text, "name"))).toEqual(["a/cheap", "b/free-open", "a/new-reasoner", "b/unknown"]);
  });

  it("presets are complete filter sets", () => {
    const rec = presetFilters("recommended");
    expect(rec).toMatchObject({ query: "", vendor: "", minContext: 128_000, releasedWithinDays: 365, sort: "newest", flags: { tools: true } });
    expect(ids(filterModels(models, rec, { now }))).toEqual(["a/new-reasoner", "a/cheap"]);
    expect(ids(filterModels(models, presetFilters("free"), { now }))).toEqual(["b/free-open"]);
    expect(presetFilters("nope")).toEqual({ ...DEFAULT_FILTERS, flags: {} });
    // presets never share their flags object with the caller
    presetFilters("free").flags.tools = true;
    expect(presetFilters("free").flags).toEqual({ free: true });
  });

  it("counts models per owner, most first", () => {
    expect(vendorFacets(models)).toEqual([{ vendor: "a", count: 2 }, { vendor: "b", count: 2 }]);
  });

  it("formats context and price", () => {
    expect(blendedCost({ cost: { input: 1, output: 5 } })).toBe(2);
    expect(blendedCost({})).toBeNull();
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(1_048_576)).toBe("1M");
    expect(formatTokens(2_500_000)).toBe("2.5M");
    expect(formatTokens(262_144)).toBe("262k");
    expect(formatTokens(null)).toBeNull();
    expect(formatCost({ free: true })).toBe("Free");
    expect(formatCost({ cost: { input: 3, output: 15 } })).toBe("$3 / $15");
    expect(formatCost({ cost: { input: 0.0005, output: null } })).toBe("$0.001 / $?");
    expect(formatCost({})).toBeNull();
  });
});
