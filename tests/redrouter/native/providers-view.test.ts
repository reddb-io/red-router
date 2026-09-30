import test from "node:test";
import assert from "node:assert/strict";

const base = "../../../src/app/(dashboard)/dashboard/providers";
const view = await import(`${base}/providerView.ts`);
const storage = await import(`${base}/providerPageStorage.ts`);
const compact = await import(`${base}/providerCompactMode.ts`);
const utils = await import(`${base}/providerPageUtils.ts`);

type Entry = {
  providerId: string;
  provider: { id: string; name: string };
  stats: { total: number };
  displayAuthType: "oauth" | "apikey" | "compatible" | "no-auth";
  toggleAuthType: "oauth" | "free" | "apikey" | "no-auth";
};

const entry = (
  providerId: string,
  displayAuthType: Entry["displayAuthType"],
  total = 0,
  name = providerId
): Entry => ({
  providerId,
  provider: { id: providerId, name },
  stats: { total },
  displayAuthType,
  toggleAuthType: displayAuthType === "compatible" ? "apikey" : (displayAuthType as never),
});

const availability = {
  openai: { enabled: true, kind: "connected" },
  aihorde: { enabled: true, kind: "free-optin" },
  uncloseai: { enabled: false, kind: "available" },
  "veo-free": { enabled: false, kind: "available" },
  anthropic: { enabled: false, kind: "available" },
};

// ── view preference parsing and persistence ─────────────────────────────────────────────────────

test("view preference parser accepts only the three known views", () => {
  assert.equal(storage.parseProviderViewPreference("enabled"), "enabled");
  assert.equal(storage.parseProviderViewPreference("free"), "free");
  assert.equal(storage.parseProviderViewPreference("all"), "all");
  for (const bad of ["", "Enabled", "compact", "true", null, undefined, 1, {}, ["all"]]) {
    assert.equal(storage.parseProviderViewPreference(bad), null, String(bad));
  }
});

test("the page opens on the enabled view without storage, with corrupt storage or when storage throws", () => {
  assert.equal(storage.DEFAULT_PROVIDER_VIEW, "enabled");
  assert.equal(storage.readProviderViewPreference(null), "enabled");
  assert.equal(storage.readProviderViewPreference({ getItem: () => null }), "enabled");
  assert.equal(storage.readProviderViewPreference({ getItem: () => "everything" }), "enabled");
  assert.equal(storage.readProviderViewPreference({ getItem: () => "{not json" }), "enabled");
  assert.equal(
    storage.readProviderViewPreference({
      getItem: () => {
        throw new Error("SecurityError");
      },
    }),
    "enabled"
  );
});

test("view preference round-trips and never throws from a broken storage", () => {
  const map = new Map<string, string>();
  const fake = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
  storage.writeProviderViewPreference("all", fake);
  assert.equal(map.get(storage.PROVIDER_VIEW_STORAGE_KEY), "all");
  assert.equal(storage.readProviderViewPreference(fake), "all");
  storage.writeProviderViewPreference("free", fake);
  assert.equal(storage.readProviderViewPreference(fake), "free");
  // The default is the absence of a preference.
  storage.writeProviderViewPreference("enabled", fake);
  assert.equal(map.has(storage.PROVIDER_VIEW_STORAGE_KEY), false);

  const broken = {
    getItem: () => null,
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
    removeItem: () => {
      throw new Error("SecurityError");
    },
  };
  assert.doesNotThrow(() => storage.writeProviderViewPreference("all", broken));
  assert.doesNotThrow(() => storage.writeProviderViewPreference("enabled", broken));
  assert.doesNotThrow(() => storage.writeProviderViewPreference("all", null));
});

// ── availability payload ────────────────────────────────────────────────────────────────────────

test("availability payload is shape-checked and unknown kinds degrade to available", () => {
  assert.equal(view.normalizeProviderAvailability(undefined), null);
  assert.equal(view.normalizeProviderAvailability(null), null);
  assert.equal(view.normalizeProviderAvailability([]), null);
  assert.equal(view.normalizeProviderAvailability("x"), null);
  assert.deepEqual(
    view.normalizeProviderAvailability({
      a: { enabled: true, kind: "connected" },
      b: { enabled: false, kind: "weird" },
      c: { enabled: "yes", kind: "connected" },
      d: null,
      e: { enabled: true, kind: "free-optin" },
    }),
    {
      a: { enabled: true, kind: "connected" },
      b: { enabled: false, kind: "available" },
      e: { enabled: true, kind: "free-optin" },
    }
  );
});

test("loadProviderPageData surfaces providerAvailability and degrades to null", async () => {
  const respond = (url: string) => {
    if (url === "/api/providers") {
      return Response.json({ connections: [], providerAvailability: availability });
    }
    return Response.json({});
  };
  const withAvailability = await utils.loadProviderPageData(
    (async (url: string) => respond(url)) as never,
    50
  );
  assert.deepEqual(withAvailability.providerAvailability.aihorde, {
    enabled: true,
    kind: "free-optin",
  });

  const without = await utils.loadProviderPageData(
    (async () => new Response("{}", { status: 500 })) as never,
    50
  );
  assert.equal(without.providerAvailability, null);
});

// ── filtering by view ───────────────────────────────────────────────────────────────────────────

test("the enabled view keeps connected providers and enabled free sources only", () => {
  const entries = [
    entry("openai", "apikey", 1),
    entry("anthropic", "apikey", 0),
    entry("aihorde", "no-auth"),
    entry("uncloseai", "no-auth"),
    entry("veo-free", "no-auth"),
  ];
  assert.deepEqual(
    view
      .filterProviderEntriesByView(entries, "enabled", availability)
      .map((e: Entry) => e.providerId),
    ["openai", "aihorde"]
  );
});

test("nothing keyless is enabled when availability is unknown or empty", () => {
  const entries = [entry("aihorde", "no-auth"), entry("uncloseai", "no-auth")];
  assert.deepEqual(view.filterProviderEntriesByView(entries, "enabled", null), []);
  assert.deepEqual(view.filterProviderEntriesByView(entries, "enabled", undefined), []);
  assert.deepEqual(view.filterProviderEntriesByView(entries, "enabled", {}), []);
});

test("only what the server reports as enabled is in the enabled view; hand-made compatible nodes stay", () => {
  // A provider whose connections are all switched off has no ACTIVE connection, so it is not
  // enabled (availability says available). It stays reachable from the all view, via Manage.
  const switchedOff = entry("anthropic", "apikey", 2);
  const node = entry("openai-compatible-abc", "compatible", 0);
  const stranger = entry("fireworks", "apikey", 0);
  assert.deepEqual(
    view
      .filterProviderEntriesByView([switchedOff, node, stranger], "enabled", availability)
      .map((e: Entry) => e.providerId),
    ["openai-compatible-abc"]
  );
});

test("the all view is the whole catalogue and the free view is the keyless sources", () => {
  const entries = [entry("openai", "apikey", 1), entry("aihorde", "no-auth"), entry("x", "oauth")];
  assert.equal(view.filterProviderEntriesByView(entries, "all", availability), entries);
  assert.deepEqual(
    view.filterProviderEntriesByView(entries, "free", availability).map((e: Entry) => e.providerId),
    ["aihorde"]
  );
});

test("enabled counts are per provider, not per row", () => {
  const entries = [
    entry("openai", "apikey", 1),
    entry("openai", "oauth", 1),
    entry("uncloseai", "no-auth"),
  ];
  assert.equal(view.countEnabledProviderEntries(entries, availability), 1);
});

// ── compact mode ────────────────────────────────────────────────────────────────────────────────

function compactOptions(overrides: Record<string, unknown> = {}) {
  const empty: Entry[] = [];
  return {
    activeCategory: null,
    showFreeOnly: false,
    freeSectionEntries: empty,
    compatibleProviderEntries: empty,
    oauthProviderEntries: empty,
    ideProviderEntries: empty,
    noAuthEntries: empty,
    upstreamProxyEntries: empty,
    llmProviderEntries: empty,
    aggregatorProviderEntries: empty,
    enterpriseProviderEntries: empty,
    embeddingRerankProviderEntries: empty,
    imageProviderEntries: empty,
    videoProviderEntries: empty,
    webCookieProviderEntries: empty,
    searchProviderEntries: empty,
    webFetchEntries: empty,
    audioProviderEntries: empty,
    localProviderEntries: empty,
    cloudAgentProviderEntries: empty,
    ...overrides,
  };
}

const ids = (list: Entry[]) => list.map((e) => e.providerId);

test("compact mode never lists a provider that is not enabled", () => {
  const options = compactOptions({
    noAuthEntries: [
      entry("aihorde", "no-auth"),
      entry("uncloseai", "no-auth"),
      entry("veo-free", "no-auth"),
    ],
    llmProviderEntries: [entry("openai", "apikey", 1), entry("anthropic", "apikey", 0)],
    searchProviderEntries: [entry("brave-search", "apikey", 0)],
    localProviderEntries: [entry("ollama-local", "apikey", 0)],
    providerAvailability: availability,
  });
  // The default view is "enabled": categories and keyless sources alike respect availability.
  assert.deepEqual(ids(compact.buildCompactProviderEntriesForPage(options)), ["openai", "aihorde"]);
  assert.deepEqual(
    ids(compact.buildCompactProviderEntriesForPage({ ...options, view: "enabled" })),
    ["openai", "aihorde"]
  );
});

test("compact mode without availability lists only providers with connections", () => {
  const options = compactOptions({
    noAuthEntries: [entry("aihorde", "no-auth")],
    llmProviderEntries: [entry("openai", "apikey", 1), entry("anthropic", "apikey", 0)],
  });
  assert.deepEqual(ids(compact.buildCompactProviderEntriesForPage(options)), ["openai"]);
});

test("compact mode lists everything only when the all view is selected", () => {
  const options = compactOptions({
    noAuthEntries: [entry("aihorde", "no-auth"), entry("uncloseai", "no-auth")],
    llmProviderEntries: [entry("openai", "apikey", 1), entry("anthropic", "apikey", 0)],
    providerAvailability: availability,
    view: "all",
  });
  assert.deepEqual(ids(compact.buildCompactProviderEntriesForPage(options)), [
    "openai",
    "anthropic",
    "aihorde",
    "uncloseai",
  ]);
});

test("compact mode keeps keyless sources after the keyed ones, deduplicated", () => {
  const options = compactOptions({
    noAuthEntries: [entry("aihorde", "no-auth")],
    llmProviderEntries: [entry("openai", "apikey", 1)],
    oauthProviderEntries: [entry("claude", "oauth", 1)],
    aggregatorProviderEntries: [entry("openai", "apikey", 1)],
    providerAvailability: { ...availability, claude: { enabled: true, kind: "connected" } },
  });
  assert.deepEqual(ids(compact.buildCompactProviderEntriesForPage(options)), [
    "claude",
    "openai",
    "aihorde",
  ]);
});

test("a category chip in compact mode still respects availability", () => {
  const options = compactOptions({
    activeCategory: "no-auth",
    noAuthEntries: [entry("aihorde", "no-auth"), entry("uncloseai", "no-auth")],
    providerAvailability: availability,
  });
  assert.deepEqual(ids(compact.buildCompactProviderEntriesForPage(options)), ["aihorde"]);
});

// ── real catalogue ──────────────────────────────────────────────────────────────────────────────

test("in the real catalogue no keyless source is enabled unless the operator turned it on", () => {
  const noStats = () => ({ total: 0 });
  const keyless = utils.buildStaticProviderEntries("no-auth", noStats) as Entry[];
  assert.ok(keyless.length > 5, "the catalogue lists several keyless sources");
  const target = keyless[0].providerId;

  assert.deepEqual(view.filterProviderEntriesByView(keyless, "enabled", {}), []);
  const picked = view.filterProviderEntriesByView(keyless, "enabled", {
    [target]: { enabled: true, kind: "free-optin" },
  });
  assert.deepEqual(ids(picked), [target]);
  assert.equal(view.filterProviderEntriesByView(keyless, "all", {}).length, keyless.length);
});

// ── ordering and catalogue metadata ─────────────────────────────────────────────────────────────

test("catalogue rows sort alphabetically by display name", () => {
  const sorted = utils.sortProviderEntriesByName([
    entry("z1", "apikey", 0, "Zeta"),
    entry("a1", "apikey", 0, "alpha"),
    entry("b1", "apikey", 0, "Beta 10"),
    entry("b2", "apikey", 0, "Beta 9"),
  ]);
  assert.deepEqual(ids(sorted), ["a1", "b2", "b1", "z1"]);
});

test("catalogue metadata gives every provider one category and one auth type", () => {
  assert.deepEqual(view.getProviderCatalogueMeta(entry("openai", "apikey"), "apikey"), {
    categoryKey: "apikey",
    categoryLabel: "LLM",
    authKey: "apikey",
    authLabel: "API key",
  });
  const claude = view.getProviderCatalogueMeta(entry("claude", "oauth"), "oauth");
  assert.equal(claude.authLabel, "OAuth");
  assert.equal(claude.categoryLabel, "Subscription");
  const free = view.getProviderCatalogueMeta(entry("aihorde", "no-auth"), "no-auth");
  assert.equal(free.categoryLabel, "Free source");
  assert.equal(free.authLabel, "No key");
  assert.equal(
    view.getProviderCatalogueMeta(entry("x", "compatible"), "compatible").categoryLabel,
    "Compatible"
  );
  assert.equal(
    view.getProviderCatalogueMeta(entry("y", "apikey"), "web-cookie").authLabel,
    "Web session"
  );
});
