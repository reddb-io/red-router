// The dashboard's model browser: every model a provider serves, with what a
// person filters on (owner, context, release date, reasoning, tools, vision,
// open weights, price). Sources, per provider:
//   - OpenRouter: its public /models list (the provider's own, freshest source),
//     completed with models.dev facts where it lacks them. The last good list is
//     saved to OPENROUTER_CATALOG_FILE, and snapshot/openrouter.json ships with
//     the repo, so the browser still lists every OpenRouter model offline;
//   - OpenCode Zen and OpenCode Go: OpenCode's live /models ids, from the cache
//     routing already keeps (open-sse/services/opencodeCatalog.js), described
//     by models.dev and the built-in registry. The last good list is saved to
//     liveCatalogFile(provider); with neither, the built-in registry list;
//   - everyone else: the models.dev catalog (anomalyco/models.dev), refreshed
//     daily by ./sync.js into CATALOG_BROWSE_FILE, or the snapshot vendored in
//     the repo until the first sync writes it.
import fs from "node:fs";
import { CATALOG_BROWSE_FILE, OPENROUTER_CATALOG_FILE, liveCatalogFile } from "open-sse/providers/catalogOverride.js";
import { OPENCODE_SYSTEM_ONE_ID_RE } from "open-sse/config/opencodeCatalog.js";
import { openCodeLiveModelIds } from "open-sse/services/opencodeCatalog.js";
import { PROVIDER_ALIASES } from "./sync.js";
import { browseSlim, slimOpenRouterModel } from "./browseShape.js";

const SNAPSHOT_API_URL = new URL("./snapshot/api.json", import.meta.url);
// OpenRouter's list as vendored in the repo (scripts/refresh-catalog-snapshots.mjs).
const OPENROUTER_SNAPSHOT_URL = new URL("./snapshot/openrouter.json", import.meta.url);
// Without output_modalities OpenRouter lists only text generators, hiding image,
// audio and decision models (e.g. TypeSafe's typesafe/jev-1.13).
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models?output_modalities=all";
const LIVE_TTL_MS = 60 * 60 * 1000;

// Our provider id -> models.dev provider id, on top of the sync's aliases (which
// cover limits). Ids that match models.dev already need no entry. Only map when
// the upstream serves the same ids: subscription CLIs (codex, gemini-cli,
// antigravity, grok-cli) expose a subset under their own names and stay unmapped.
const BROWSE_ALIASES = {
  ...PROVIDER_ALIASES,
  github: "github-copilot",
  fireworks: "fireworks-ai",
  together: "togetherai",
  vertex: "google-vertex",
  "opencode-zen": "opencode",
  "vercel-ai-gateway": "vercel",
  kilocode: "kilo",
  "kilo-gateway": "kilo",
  iflow: "iflowcn",
  "xiaomi-mimo": "xiaomi",
  "volcengine-ark": "volcengine",
  alicode: "alibaba-coding-plan-cn",
  "alicode-intl": "alibaba-coding-plan",
  "alims-intl": "alibaba",
  "alitp-intl": "alibaba-token-plan",
  ollama: "ollama-cloud",
  "xiaomi-tokenplan": "xiaomi-token-plan-sgp",
  clinepass: "cline-pass",
};

// Providers that only serve the free slice of the catalog they map to
// (OpenCode Free is OpenCode Zen's free models).
const FREE_ONLY = new Set(["opencode"]);

// Providers whose live /models (ids only) decides what the browser lists.
const OPENCODE_LISTS = new Set(["opencode-zen", "opencode-go"]);

export function modelsDevProviderId(providerId) {
  return BROWSE_ALIASES[providerId] || providerId;
}

let browseCache = null;
let browseMtime = -1;
let snapshotCache = null;

function readBrowseCatalog() {
  try {
    const mtime = fs.statSync(CATALOG_BROWSE_FILE).mtimeMs;
    if (mtime !== browseMtime) {
      browseCache = JSON.parse(fs.readFileSync(CATALOG_BROWSE_FILE, "utf8"));
      browseMtime = mtime;
    }
    return browseCache;
  } catch {
    // Not synced yet: the vendored snapshot, shaped once per process.
    if (!snapshotCache) {
      try { snapshotCache = browseSlim(JSON.parse(fs.readFileSync(SNAPSHOT_API_URL, "utf8"))); } catch { snapshotCache = {}; }
    }
    return snapshotCache;
  }
}

// "anthropic/claude-x" is Anthropic's; a bare id, or one namespaced by the
// provider itself ("cline-pass/glm-5.2"), belongs to whoever serves it.
function vendorOf(id, fallback, providerKey) {
  const prefix = id.includes("/") ? id.split("/")[0] : null;
  return prefix && prefix !== providerKey ? prefix : fallback;
}

function fromModelsDev(id, m, providerName, providerKey) {
  const inputs = m.i || [];
  const free = (m.ci === 0 && m.co === 0) || id.endsWith(":free");
  return {
    id,
    name: m.n || id,
    vendor: vendorOf(id, providerName, providerKey),
    family: m.f || null,
    releaseDate: m.d || null,
    updatedDate: m.u || null,
    knowledge: m.k || null,
    contextWindow: m.c || null,
    maxOutput: m.o || null,
    reasoning: m.r === true,
    tools: m.t === true,
    vision: inputs.includes("image"),
    pdf: inputs.includes("pdf"),
    audio: inputs.includes("audio"),
    video: inputs.includes("video"),
    imageOutput: (m.x || []).includes("image"),
    textOutput: m.nt !== true && m.y !== "decision",
    // A System One decision model (models.dev type), answered through /v1/systemone.
    ...(m.y === "decision" ? { decision: true } : {}),
    openWeights: m.w === true,
    free,
    cost: typeof m.ci === "number" || typeof m.co === "number" ? { input: m.ci ?? null, output: m.co ?? null } : null,
  };
}

let openrouterLive = { at: 0, models: null, origin: null, fetchedAt: null };
// Offline, retry the network this often instead of waiting out a timeout per page view.
const OFFLINE_RETRY_MS = 5 * 60 * 1000;

const perMillion = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 1e6 * 1e4) / 1e4 : null; };

/** A slim OpenRouter entry (browseShape.slimOpenRouterModel) in the browser's shape, per million tokens. */
function mapOpenRouterModel(m) {
  const params = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
  const inputs = m.architecture?.input_modalities || [];
  const outputs = m.architecture?.output_modalities?.length ? m.architecture.output_modalities : ["text"];
  const costIn = perMillion(m.pricing?.prompt);
  const costOut = perMillion(m.pricing?.completion);
  return {
    id: m.id,
    name: m.name || m.id,
    vendor: vendorOf(m.id, "openrouter"),
    family: null,
    releaseDate: Number.isFinite(m.created) ? new Date(m.created * 1000).toISOString().slice(0, 10) : null,
    updatedDate: null,
    knowledge: null,
    contextWindow: m.context_length || m.top_provider?.context_length || null,
    maxOutput: m.top_provider?.max_completion_tokens || null,
    reasoning: params.includes("reasoning") || params.includes("include_reasoning"),
    tools: params.includes("tools"),
    vision: inputs.includes("image"),
    pdf: inputs.includes("file"),
    audio: inputs.includes("audio"),
    video: inputs.includes("video"),
    imageOutput: outputs.includes("image"),
    textOutput: outputs.includes("text"),
    // System One decision models answer through /v1/systemone, not chat.
    decision: outputs.includes("decisions"),
    openWeights: false,
    free: m.id.endsWith(":free") || (costIn === 0 && costOut === 0),
    cost: costIn !== null || costOut !== null ? { input: costIn, output: costOut } : null,
    description: typeof m.description === "string" ? m.description.slice(0, 280) : null,
  };
}

// A saved or vendored list: { fetchedAt, [key]: [...] }, or null when missing or empty.
function readListFile(file, key = "models") {
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(saved?.[key]) && saved[key].length ? saved : null;
  } catch {
    return null;
  }
}

function saveListFile(file, value) {
  try {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, file);
  } catch {
    // Best effort: the live list still serves this process.
  }
}

/**
 * OpenRouter's own list: live when reachable (and saved to disk), else the last
 * saved list, else the snapshot vendored in the repo. Null only if none exists.
 * @returns {Promise<{ models: object[], origin: "live"|"saved"|"snapshot", fetchedAt: string|null }|null>}
 */
async function fetchOpenRouterModels(fetchImpl = fetch) {
  if (openrouterLive.models && Date.now() - openrouterLive.at < LIVE_TTL_MS) return openrouterLive;
  try {
    const res = await fetchImpl(OPENROUTER_MODELS_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    const data = res.ok ? (await res.json())?.data : null;
    if (Array.isArray(data) && data.length) {
      const slim = data.map(slimOpenRouterModel);
      const fetchedAt = new Date().toISOString();
      saveListFile(OPENROUTER_CATALOG_FILE, { fetchedAt, models: slim });
      openrouterLive = { at: Date.now(), models: slim.map(mapOpenRouterModel), origin: "live", fetchedAt };
      return openrouterLive;
    }
  } catch {
    // Offline or OpenRouter down: fall through to what is on disk.
  }
  if (openrouterLive.models) return openrouterLive;
  const saved = readListFile(OPENROUTER_CATALOG_FILE);
  const stored = saved || readListFile(OPENROUTER_SNAPSHOT_URL);
  if (!stored) return null;
  openrouterLive = {
    at: Date.now() - LIVE_TTL_MS + OFFLINE_RETRY_MS,
    models: stored.models.map(mapOpenRouterModel),
    origin: saved ? "saved" : "snapshot",
    fetchedAt: stored.fetchedAt || null,
  };
  return openrouterLive;
}

// fetchedAt of the OpenCode list last written to disk, per provider.
const openCodeSaved = new Map();

/**
 * OpenCode's model ids for Zen or Go: live (and saved to disk) when OpenCode
 * answers, else the last saved list, else the built-in registry list.
 * @returns {Promise<{ ids: string[], builtIn: object[], origin: "live"|"saved"|"builtin", fetchedAt: string|null }>}
 */
async function openCodeModelIds(providerId, fetchImpl) {
  const file = liveCatalogFile(providerId);
  const live = await openCodeLiveModelIds(providerId, { fetchImpl });
  if (live.ids) {
    if (openCodeSaved.get(providerId) !== live.fetchedAt) {
      saveListFile(file, { fetchedAt: live.fetchedAt, ids: live.ids });
      openCodeSaved.set(providerId, live.fetchedAt);
    }
    return { ids: live.ids, builtIn: live.builtIn, origin: "live", fetchedAt: live.fetchedAt };
  }
  const saved = readListFile(file, "ids");
  const ids = saved?.ids.filter((id) => typeof id === "string" && id);
  if (ids?.length) return { ids, builtIn: live.builtIn, origin: "saved", fetchedAt: saved.fetchedAt || null };
  return { ids: live.builtIn.map((m) => m.id), builtIn: live.builtIn, origin: "builtin", fetchedAt: null };
}

/**
 * One id of an OpenCode list in the browser's shape: models.dev's facts when it
 * has the model, else the built-in name. JEV models are System One decision
 * models, answered through /v1/systemone, not chat.
 */
function describeOpenCodeModel(id, { md, builtIn, providerName, mdId }) {
  const model = md || { ...fromModelsDev(id, { n: builtIn?.name }, providerName, mdId), free: /[-:]free$/.test(id) };
  if (builtIn?.kind !== "systemone" && !OPENCODE_SYSTEM_ONE_ID_RE.test(id)) return model;
  return { ...model, decision: true, textOutput: false };
}

/**
 * models.dev's slim entries (browseShape) for one of our providers, by model id;
 * empty when models.dev does not know the provider.
 */
export function modelsDevModels(providerId) {
  return readBrowseCatalog()?.[modelsDevProviderId(providerId)]?.m || {};
}

/**
 * Every model we can describe for a provider, newest first.
 * @returns {Promise<{ provider: string, source: string|null, fetchedAt: string|null, models: object[] }>}
 */
export async function getProviderCatalog(providerId, { fetchImpl } = {}) {
  const mdId = modelsDevProviderId(providerId);
  const catalog = readBrowseCatalog() || {};
  const entry = catalog[mdId];
  const fromMd = entry ? Object.entries(entry.m || {}).map(([id, m]) => fromModelsDev(id, m, entry.n || mdId, mdId)) : [];

  let models = fromMd;
  let source = entry ? "models.dev" : null;
  let fetchedAt = null;
  if (providerId === "openrouter") {
    const list = await fetchOpenRouterModels(fetchImpl);
    if (list?.models?.length) {
      // OpenRouter's list decides what exists; models.dev fills what it lacks.
      const md = new Map(fromMd.map((m) => [m.id, m]));
      models = list.models.map((m) => {
        const extra = md.get(m.id);
        if (!extra) return m;
        return {
          ...m,
          family: extra.family,
          releaseDate: extra.releaseDate || m.releaseDate,
          knowledge: extra.knowledge,
          openWeights: extra.openWeights,
          reasoning: m.reasoning || extra.reasoning,
          tools: m.tools || extra.tools,
        };
      });
      // "openrouter", "openrouter-saved" or "openrouter-snapshot", + models.dev when it helped.
      const base = list.origin === "live" ? "openrouter" : `openrouter-${list.origin}`;
      source = entry ? `${base}+models.dev` : base;
      fetchedAt = list.fetchedAt;
    }
  }

  if (OPENCODE_LISTS.has(providerId)) {
    // OpenCode's list decides what exists; models.dev, then the registry, describe it.
    const list = await openCodeModelIds(providerId, fetchImpl);
    const md = new Map(fromMd.map((m) => [m.id, m]));
    const builtIn = new Map(list.builtIn.map((m) => [m.id, m]));
    const providerName = entry?.n || providerId;
    models = list.ids.map((id) => describeOpenCodeModel(id, { md: md.get(id), builtIn: builtIn.get(id), providerName, mdId }));
    // "opencode-zen", "opencode-zen-saved" or "opencode-zen-builtin", + models.dev when it helped.
    const base = list.origin === "live" ? providerId : `${providerId}-${list.origin}`;
    source = entry ? `${base}+models.dev` : base;
    fetchedAt = list.fetchedAt;
  }

  if (FREE_ONLY.has(providerId)) models = models.filter((m) => m.free);
  models.sort((a, b) => String(b.releaseDate || "").localeCompare(String(a.releaseDate || "")) || a.id.localeCompare(b.id));
  return { provider: providerId, source, fetchedAt, models };
}

/** Test hook. */
export function resetBrowseCatalog() {
  browseCache = null;
  browseMtime = -1;
  snapshotCache = null;
  openrouterLive = { at: 0, models: null, origin: null, fetchedAt: null };
  openCodeSaved.clear();
}
