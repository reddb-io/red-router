// /v1/models tells clients every parameter of a model they must respect — and for a
// combo, those of the strictest member it may route to — plus a catalog version that
// changes when any of it does.
import { describe, it, expect, beforeAll } from "vitest";
import { modelParameters, mergeModelParameters } from "../../open-sse/providers/modelParameters.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

let db;
let buildModelsList;
let catalog;

beforeAll(async () => {
  db = await import("@/lib/db/index.js");
  await db.initDb();
  await db.createCombo({ name: "opus-mix", models: ["cc/claude-opus-5-5", "cc/claude-opus-5"] });
  await db.createCombo({ name: "outer", models: ["opus-mix", "gh/gpt-4o"] });
  ({ buildModelsList } = await import("../../src/app/api/v1/models/route.js"));
  catalog = await import("../../src/lib/catalogVersion.js");
});

const combo = async (name) => (await buildModelsList(["llm"])).find((m) => m.id === name);

describe("modelParameters", () => {
  it("states Opus 5.5's restrictions", () => {
    const p = modelParameters(getCapabilitiesForModel("claude", "claude-opus-5-5"), ["low", "medium", "high"]);
    expect(p).toMatchObject({
      context_length: 1000000,
      max_completion_tokens: 128000,
      reasoning: true,
      thinking_levels: ["low", "medium", "high"],
      thinking_can_disable: false,
      forced_tool_choice: false,
      modalities: { input: ["text", "image"], output: ["text"] },
    });
  });

  it("leaves thinking settings neutral on a model that does not reason", () => {
    const p = modelParameters({ ...getCapabilitiesForModel("gh", "gpt-4o"), reasoning: false }, ["high"]);
    expect(p).toMatchObject({ reasoning: false, thinking_levels: null, thinking_can_disable: true, forced_tool_choice: true });
  });
});

describe("mergeModelParameters", () => {
  const a = { context_length: 200000, max_completion_tokens: 64000, reasoning: true, thinking_levels: ["low", "medium", "high"], thinking_can_disable: true, forced_tool_choice: true, tools: true, search: false, modalities: { input: ["text"], output: ["text"] } };
  const b = { context_length: 1000000, max_completion_tokens: 128000, reasoning: true, thinking_levels: ["medium", "high", "max"], thinking_can_disable: false, forced_tool_choice: false, tools: true, search: true, modalities: { input: ["text", "image"], output: ["text"] } };

  it("takes the strictest member for everything a client must respect", () => {
    expect(mergeModelParameters([a, b])).toEqual({
      context_length: 200000,
      max_completion_tokens: 64000,
      reasoning: true,
      thinking_levels: ["medium", "high"],
      thinking_can_disable: false,
      forced_tool_choice: false,
      tools: true,
      search: true,
      modalities: { input: ["text", "image"], output: ["text"] },
    });
  });

  it("omits a limit some member does not state rather than guessing it", () => {
    const { context_length, ...unknown } = a;
    expect(mergeModelParameters([unknown, b]).context_length).toBeUndefined();
  });
});

describe("/v1/models combos", () => {
  it("lists the members a combo can route to, nested combos expanded", async () => {
    expect((await combo("opus-mix")).members).toEqual(["cc/claude-opus-5-5", "cc/claude-opus-5"]);
    expect((await combo("outer")).members).toEqual(["cc/claude-opus-5-5", "cc/claude-opus-5", "gh/gpt-4o"]);
  });

  it("reports the strictest member's restrictions in parameters and capabilities", async () => {
    const entry = await combo("opus-mix");
    expect(entry.parameters).toMatchObject({ thinking_can_disable: false, forced_tool_choice: false, reasoning: true });
    // Was OR'd before: one member that cannot disable thinking makes the combo unable to.
    expect(entry.capabilities.thinkingCanDisable).toBe(false);
    expect(entry.capabilities.forcedToolChoice).toBe(false);
  });
});

describe("catalog version", () => {
  it("is stable while nothing changes and changes when a combo's members do", async () => {
    catalog.resetCatalogVersions();
    const first = await catalog.getCatalogVersion();
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(await catalog.getCatalogVersion()).toBe(first);

    const [mix] = (await db.getCombos()).filter((c) => c.name === "opus-mix");
    await db.updateCombo(mix.id, { models: ["cc/claude-opus-5"] });
    catalog.resetCatalogVersions();
    expect(await catalog.getCatalogVersion()).not.toBe(first);
    await db.updateCombo(mix.id, { models: ["cc/claude-opus-5-5", "cc/claude-opus-5"] });
  });

  it("never makes the chat path wait: peek returns the cached value and refreshes in background", async () => {
    catalog.resetCatalogVersions();
    expect(catalog.peekCatalogVersion("k-peek")).toBeNull();
    const version = await catalog.getCatalogVersion("k-peek");
    expect(catalog.peekCatalogVersion("k-peek")).toBe(version);
  });
});
