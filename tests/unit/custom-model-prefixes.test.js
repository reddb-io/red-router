// A user gives connections of a built-in provider their own model prefix
// ("codex-work/<model>"): the prefix routes to those accounts only, /v1/models lists
// the provider's models under it, and user aliases are listed as models of their own.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getCombos: vi.fn(),
  getModelAliases: vi.fn(),
  getModelAliasNames: vi.fn(),
  getModelDisplayNames: vi.fn(),
  getSettings: vi.fn(),
  getProviderNodes: vi.fn(),
  getComboByName: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getApiKeyAllowedConnectionIds: vi.fn(async () => null),
  getCombos: mocks.getCombos,
  getCustomModels: vi.fn(async () => []),
  getModelAliases: mocks.getModelAliases,
  getModelAliasNames: mocks.getModelAliasNames,
  getModelDisplayNames: mocks.getModelDisplayNames,
  getSettings: mocks.getSettings,
  getApiKeyOwner: vi.fn(async () => null),
  getComboByName: mocks.getComboByName,
  getProviderNodes: mocks.getProviderNodes,
}));

vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: vi.fn(async () => ({})) }));

const { buildModelsList } = await import("@/app/api/v1/models/route.js");
const { GET: getModel } = await import("@/app/api/v1/models/[...model]/route.js");
const { getModelInfo } = await import("@/sse/services/model.js");
const { validateConnectionPrefix } = await import("@/lib/connectionPrefix.js");
const { groupCatalog } = await import("@/lib/catalog.js");

const conn = (id, provider, { prefix, name, models = ["gpt-5.5"] } = {}) => ({
  id,
  provider,
  name,
  isActive: true,
  priority: 1,
  providerSpecificData: { enabledModels: models, ...(prefix ? { prefix } : {}) },
});
const byId = (list, id) => list.find((m) => m.id === id);
const list = () => buildModelsList(["llm"], { skipDynamicFetch: true });
const lookup = async (id) => {
  const res = await getModel(new Request(`http://localhost/v1/models/${id}`), { params: Promise.resolve({ model: id.split("/") }) });
  return { status: res.status, body: await res.json() };
};

const WORK = conn("cx-work", "codex", { prefix: "codex-work", name: "Work" });
const HOME = conn("cx-home", "codex", { prefix: "codex-home", name: "Home" });
const PLAIN = conn("cx-plain", "codex", { name: "Plain" });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCombos.mockResolvedValue([]);
  mocks.getModelAliases.mockResolvedValue({});
  mocks.getModelAliasNames.mockResolvedValue({});
  mocks.getModelDisplayNames.mockResolvedValue({});
  mocks.getSettings.mockResolvedValue({});
  mocks.getProviderNodes.mockResolvedValue([]);
  mocks.getComboByName.mockResolvedValue(null);
  mocks.getProviderConnections.mockResolvedValue([WORK, HOME]);
});

describe("connection prefix validation", () => {
  const check = (prefix, providerId = "codex", connectionId = "cx-work") => validateConnectionPrefix({ prefix, providerId, connectionId });

  it("accepts a free lowercase name and clears on empty", async () => {
    expect(await check("codex-personal")).toEqual({ prefix: "codex-personal" });
    expect(await check("  my.codex_2  ")).toEqual({ prefix: "my.codex_2" });
    expect(await check("")).toEqual({ prefix: "" });
    expect(await check(undefined)).toEqual({ prefix: "" });
  });

  it.each(["Codex-Work", "codex work", "-codex", ".codex", "codex/work", "a".repeat(65)])("rejects the malformed prefix %j", async (prefix) => {
    expect((await check(prefix)).error).toBeTruthy();
  });

  it("rejects another provider's id, slug, alias and ui alias", async () => {
    for (const token of ["claude", "claude-code", "cc", "openai", "copilot", "gh"]) {
      expect((await check(token)).error).toMatch(/built-in prefix of/);
    }
  });

  it("rejects the provider's own default prefixes as pointless", async () => {
    expect((await check("codex")).error).toMatch(/own prefix/);
    expect((await check("cx")).error).toMatch(/own prefix/);
  });

  it("rejects a prefix another provider's connection, a custom node or a combo owns", async () => {
    mocks.getProviderConnections.mockResolvedValue([WORK, conn("cl", "claude", { prefix: "work-claude", name: "Claude work" })]);
    expect((await check("work-claude")).error).toMatch(/Claude.*connection "Claude work"/);

    mocks.getProviderNodes.mockResolvedValue([{ id: "openai-compatible-x", prefix: "mynode", name: "My node" }]);
    expect((await check("mynode")).error).toMatch(/custom provider "My node"/);

    mocks.getCombos.mockResolvedValue([{ name: "fast", models: [] }]);
    expect((await check("fast")).error).toMatch(/combo/);
  });

  it("lets connections of the same provider share a prefix as one pool", async () => {
    expect(await check("codex-home", "codex", "cx-work")).toEqual({ prefix: "codex-home" });
  });
});

describe("routing a connection prefix", () => {
  it("pins each prefix to its own account", async () => {
    expect(await getModelInfo("codex-work/gpt-5.5")).toEqual({ provider: "codex", model: "gpt-5.5", connectionIds: ["cx-work"] });
    expect(await getModelInfo("codex-home/gpt-5.5")).toEqual({ provider: "codex", model: "gpt-5.5", connectionIds: ["cx-home"] });
  });

  it("routes a prefix shared by several accounts to all of them", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      conn("a", "codex", { prefix: "codex-team" }),
      conn("b", "codex", { prefix: "codex-team" }),
      HOME,
    ]);
    expect((await getModelInfo("codex-team/gpt-5.5")).connectionIds).toEqual(["a", "b"]);
  });

  it("keeps the default prefixes on every account", async () => {
    expect(await getModelInfo("codex/gpt-5.5")).toEqual({ provider: "codex", model: "gpt-5.5" });
    expect(await getModelInfo("cx/gpt-5.5")).toEqual({ provider: "codex", model: "gpt-5.5" });
  });

  it("never lets a stored prefix shadow a built-in provider token", async () => {
    mocks.getProviderConnections.mockResolvedValue([conn("bad", "codex", { prefix: "claude" })]);
    expect(await getModelInfo("claude/claude-opus-5")).toEqual({ provider: "claude", model: "claude-opus-5" });
  });

  it("resolves a user alias through a connection prefix", async () => {
    mocks.getModelAliases.mockResolvedValue({ work: "codex-work/gpt-5.5", fast: "cx/gpt-5.5" });
    expect(await getModelInfo("work")).toEqual({ provider: "codex", model: "gpt-5.5", connectionIds: ["cx-work"] });
    expect(await getModelInfo("fast")).toEqual({ provider: "codex", model: "gpt-5.5" });
  });

  it("keeps custom node prefixes routing", async () => {
    mocks.getProviderNodes.mockImplementation(async ({ type } = {}) => (type === "openai-compatible"
      ? [{ id: "openai-compatible-chat-1", prefix: "mynode" }]
      : []));
    expect(await getModelInfo("mynode/llama")).toEqual({ provider: "openai-compatible-chat-1", model: "llama" });
  });
});

describe("/v1/models with connection prefixes", () => {
  it("lists a provider once per prefix, naming the account, without the default prefix", async () => {
    const models = await list();
    const work = byId(models, "codex-work/gpt-5.5");
    expect(work).toMatchObject({ owned_by: "codex-work", provider: { id: "codex", slug: "codex", connection: { id: "cx-work", name: "Work" } } });
    // Another account also serves codex/, so codex/ does not route to this account alone.
    expect(work.aliases).toBeUndefined();
    expect(byId(models, "codex-home/gpt-5.5").provider.connection).toEqual({ id: "cx-home", name: "Home" });
    expect(byId(models, "codex/gpt-5.5")).toBeUndefined();
  });

  it("adds the default prefix for accounts without one", async () => {
    mocks.getProviderConnections.mockResolvedValue([WORK, PLAIN]);
    const models = await list();
    expect(byId(models, "codex-work/gpt-5.5").provider.connection.id).toBe("cx-work");
    const plain = byId(models, "codex/gpt-5.5");
    expect(plain.provider.connection).toBeUndefined();
    expect(plain.aliases).toEqual(["cx/gpt-5.5"]);
  });

  it("offers the default prefixes as aliases when every account carries the prefix", async () => {
    mocks.getProviderConnections.mockResolvedValue([WORK]);
    const work = byId(await list(), "codex-work/gpt-5.5");
    expect(work.aliases).toEqual(["codex/gpt-5.5", "cx/gpt-5.5"]);
    expect((await lookup("cx/gpt-5.5")).body.id).toBe("codex-work/gpt-5.5");
  });

  it("names no account for a prefix several accounts share", async () => {
    mocks.getProviderConnections.mockResolvedValue([conn("a", "codex", { prefix: "codex-team" }), conn("b", "codex", { prefix: "codex-team" })]);
    const team = byId(await list(), "codex-team/gpt-5.5");
    expect(team.provider.connection).toBeUndefined();
    expect(team.aliases).toEqual(["codex/gpt-5.5", "cx/gpt-5.5"]);
  });

  it("keeps the short prefix style for default listings only", async () => {
    mocks.getSettings.mockResolvedValue({ catalog: { prefixStyle: "short" } });
    mocks.getProviderConnections.mockResolvedValue([WORK, PLAIN]);
    const models = await list();
    expect(byId(models, "cx/gpt-5.5").aliases).toEqual(["codex/gpt-5.5"]);
    expect(byId(models, "codex-work/gpt-5.5")).toBeDefined();
  });

  it("is unchanged without prefixes, aliases or names", async () => {
    mocks.getProviderConnections.mockResolvedValue([PLAIN, conn("cx-2", "codex")]);
    const models = await list();
    expect(models.filter((m) => m.provider?.id === "codex").map((m) => m.id)).toEqual(["codex/gpt-5.5"]);
    const entry = byId(models, "codex/gpt-5.5");
    expect(entry.provider.connection).toBeUndefined();
    expect(entry.aliases).toEqual(["cx/gpt-5.5"]);
    expect(models.some((m) => m.owned_by === "alias")).toBe(false);
  });

  it("uses the user's display name for a model under every prefix", async () => {
    mocks.getProviderConnections.mockResolvedValue([WORK, PLAIN]);
    mocks.getModelDisplayNames.mockResolvedValue({ "codex/gpt-5.5": "My GPT" });
    const models = await list();
    expect(byId(models, "codex/gpt-5.5").name).toBe("My GPT");
    expect(byId(models, "codex-work/gpt-5.5").name).toBe("My GPT");
  });

  it("groups /v1/catalog per prefix", async () => {
    mocks.getProviderConnections.mockResolvedValue([WORK, PLAIN]);
    const groups = groupCatalog(await list(), [WORK, PLAIN]);
    const codex = groups.filter((g) => g.provider.id === "codex");
    expect(codex.map((g) => [g.provider.model_prefix, g.provider.connection?.id, g.provider.connections])).toEqual([
      ["codex-work", "cx-work", 1],
      [undefined, undefined, 2],
    ]);
  });
});

describe("/v1/models user aliases", () => {
  beforeEach(() => {
    mocks.getProviderConnections.mockResolvedValue([WORK, PLAIN]);
  });

  it("lists an alias as its own entry with its target's provider, limits and parameters", async () => {
    mocks.getModelAliases.mockResolvedValue({ fast: "cx/gpt-5.5" });
    mocks.getModelAliasNames.mockResolvedValue({ fast: "Fast lane" });
    const models = await list();
    const target = byId(models, "codex/gpt-5.5");
    const alias = byId(models, "fast");
    expect(alias).toMatchObject({ id: "fast", object: "model", owned_by: "alias", name: "Fast lane", alias_of: "codex/gpt-5.5" });
    expect(alias.provider).toEqual(target.provider);
    expect(alias.context_length).toBe(target.context_length);
    expect(alias.max_completion_tokens).toBe(target.max_completion_tokens);
    expect(alias.parameters).toEqual(target.parameters);
    expect(alias.capabilities).toEqual(target.capabilities);
    expect((await lookup("fast")).body).toEqual(alias);
  });

  it("carries the account of an alias that routes through a connection prefix", async () => {
    mocks.getModelAliases.mockResolvedValue({ work: "codex-work/gpt-5.5" });
    const alias = byId(await list(), "work");
    expect(alias).toMatchObject({ name: "work", alias_of: "codex-work/gpt-5.5", provider: { id: "codex", connection: { id: "cx-work", name: "Work" } } });
  });

  it("describes an alias saved under a prefix no longer listed without naming an account", async () => {
    mocks.getProviderConnections.mockResolvedValue([WORK, HOME]);
    mocks.getModelAliases.mockResolvedValue({ fast: "codex/gpt-5.5" });
    const alias = byId(await list(), "fast");
    expect(alias.alias_of).toBe("codex/gpt-5.5");
    expect(alias.provider.id).toBe("codex");
    expect(alias.provider.connection).toBeUndefined();
  });

  it("skips aliases to models this caller cannot reach and yields to a combo of the same name", async () => {
    mocks.getModelAliases.mockResolvedValue({ opus: "cc/claude-opus-5", fast: "cx/gpt-5.5" });
    mocks.getCombos.mockResolvedValue([{ name: "fast", models: ["codex/gpt-5.5"] }]);
    const models = await list();
    expect(byId(models, "opus")).toBeUndefined();
    expect(models.filter((m) => m.id === "fast").map((m) => m.owned_by)).toEqual(["combo"]);
  });
});
