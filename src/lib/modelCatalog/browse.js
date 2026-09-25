// The dashboard's model browser: every model a provider serves, with what a
// person filters on (owner, context, release date, reasoning, tools, vision,
// open weights, price). Sources, per provider:
//   - OpenRouter: its public /models list (the provider's own, freshest source),
//     completed with models.dev facts where it lacks them;
//   - everyone else: the models.dev catalog (anomalyco/models.dev), refreshed
//     daily by ./sync.js into CATALOG_BROWSE_FILE, or the snapshot vendored in
//     the repo until the first sync writes it.
import fs from "node:fs";
import { CATALOG_BROWSE_FILE } from "open-sse/providers/catalogOverride.js";
import { PROVIDER_ALIASES } from "./sync.js";
import { browseSlim } from "./browseShape.js";

const SNAPSHOT_API_URL = new URL("./snapshot/api.json", import.meta.url);
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
    textOutput: m.nt !== true,
    openWeights: m.w === true,
    free,
    cost: typeof m.ci === "number" || typeof m.co === "number" ? { input: m.ci ?? null, output: m.co ?? null } : null,
  };
}

let openrouterLive = { at: 0, models: null };

/** OpenRouter's own list, per million tokens like models.dev. Null when unreachable. */
async function fetchOpenRouterModels(fetchImpl = fetch) {
  if (openrouterLive.models && Date.now() - openrouterLive.at < LIVE_TTL_MS) return openrouterLive.models;
  try {
    const res = await fetchImpl(OPENROUTER_MODELS_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return openrouterLive.models;
    const data = (await res.json())?.data;
    if (!Array.isArray(data)) return openrouterLive.models;
    const perMillion = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 1e6 * 1e4) / 1e4 : null; };
    const models = data.map((m) => {
      const params = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
      const inputs = m.architecture?.input_modalities || [];
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
        imageOutput: (m.architecture?.output_modalities || []).includes("image"),
        textOutput: (m.architecture?.output_modalities || ["text"]).includes("text"),
        // System One decision models answer through /v1/systemone, not chat.
        decision: (m.architecture?.output_modalities || []).includes("decisions"),
        openWeights: false,
        free: m.id.endsWith(":free") || (costIn === 0 && costOut === 0),
        cost: costIn !== null || costOut !== null ? { input: costIn, output: costOut } : null,
        description: typeof m.description === "string" ? m.description.slice(0, 280) : null,
      };
    });
    openrouterLive = { at: Date.now(), models };
    return models;
  } catch {
    return openrouterLive.models;
  }
}

/**
 * Every model we can describe for a provider, newest first.
 * @returns {Promise<{ provider: string, source: string|null, models: object[] }>}
 */
export async function getProviderCatalog(providerId, { fetchImpl } = {}) {
  const mdId = modelsDevProviderId(providerId);
  const catalog = readBrowseCatalog() || {};
  const entry = catalog[mdId];
  const fromMd = entry ? Object.entries(entry.m || {}).map(([id, m]) => fromModelsDev(id, m, entry.n || mdId, mdId)) : [];

  let models = fromMd;
  let source = entry ? "models.dev" : null;
  if (providerId === "openrouter") {
    const live = await fetchOpenRouterModels(fetchImpl);
    if (live?.length) {
      // The live list decides what exists; models.dev fills what it lacks.
      const md = new Map(fromMd.map((m) => [m.id, m]));
      models = live.map((m) => {
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
      source = entry ? "openrouter+models.dev" : "openrouter";
    }
  }

  if (FREE_ONLY.has(providerId)) models = models.filter((m) => m.free);
  models.sort((a, b) => String(b.releaseDate || "").localeCompare(String(a.releaseDate || "")) || a.id.localeCompare(b.id));
  return { provider: providerId, source, models };
}

/** Test hook. */
export function resetBrowseCatalog() {
  browseCache = null;
  browseMtime = -1;
  snapshotCache = null;
  openrouterLive = { at: 0, models: null };
}
