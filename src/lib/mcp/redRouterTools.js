// RedRouter's own MCP tools: read-only views of what the calling API key can
// use (models, combos, flat models, providers) and what it has spent, so an
// agent can suggest a better model or combo. Nothing here changes routing: a
// client applies a suggestion by sending a different `model`, after its user
// agrees. Every view is the one /v1/models gives the same key; provider views
// carry counts and health, never account names, e-mails or credentials.
import { getProviderConnections, getApiKeyAllowedConnectionIds } from "@/lib/localDb";
import { getApiKeyModelIdFormat, getApiKeyPolicy } from "@/lib/db/repos/apiKeysRepo.js";
import { getApiKeyUsageTotals } from "@/lib/db/repos/usageRepo.js";
import { getPricingForModel } from "@/lib/db/repos/pricingRepo.js";
import { getDb } from "@/lib/db/kysely.js";
import { offerOf } from "@/lib/flatModels.js";
import { summarizeConnectionHealth } from "open-sse/services/providerHealth.js";

const CAPABILITIES = ["vision", "tools", "reasoning", "pdf", "search", "imageOutput", "audioInput", "audioOutput", "videoInput"];
const MAX_LIMIT = 500;

async function catalog(apiKey) {
  const { buildModelsList } = await import("@/app/api/v1/models/route.js");
  const idFormat = await getApiKeyModelIdFormat(apiKey);
  const entries = await buildModelsList(["llm"], { apiKey, idFormat });
  return { idFormat, entries };
}

const kindOf = (e) => (e.flat ? "flat" : e.owned_by === "combo" ? "combo" : e.owned_by === "alias" ? "alias" : "model");
const capabilityList = (caps) => CAPABILITIES.filter((c) => caps?.[c] === true);

const perMillion = (p) => (p && (typeof p.input === "number" || typeof p.output === "number")
  ? { input: p.input ?? null, output: p.output ?? null } : null);

/** USD per 1M tokens for a concrete model, from RedRouter's pricing table. */
async function priceOf(entry) {
  const offer = offerOf(entry);
  if (!offer?.modelId) return null;
  return perMillion(await getPricingForModel(offer.providerId, offer.modelId).catch(() => null));
}

/** A combo's or flat model's price: its first member's (the one tried first). */
async function entryPrice(entry, byId) {
  if (entry.flat) return entry.offers?.find((o) => o.available !== false)?.price || null;
  if (entry.owned_by === "combo") {
    const lead = byId.get(entry.members?.[0]);
    return lead ? priceOf(lead) : null;
  }
  return priceOf(entry);
}

const total = (price) => (price ? (price.input || 0) + (price.output || 0) : null);

async function summarize(entry, byId, { detail = false } = {}) {
  const kind = kindOf(entry);
  const out = {
    id: entry.id,
    name: entry.name || entry.id,
    kind,
    provider: entry.provider ? { id: entry.provider.id, name: entry.provider.name || entry.provider.id } : null,
    context_length: entry.context_length ?? null,
    max_output: entry.max_completion_tokens ?? null,
    capabilities: capabilityList(entry.capabilities),
    thinking_levels: entry.thinking_levels || [],
    price_per_million: await entryPrice(entry, byId),
  };
  if (kind === "combo" || kind === "flat") {
    out.strategy = entry.strategy || "fallback";
    out.members = entry.members || [];
  }
  if (kind === "flat") {
    out.offers = (entry.offers || []).map((o) => ({ id: o.id, provider: o.provider?.name || o.provider?.id, available: o.available !== false, price: o.price, free: !!o.free }));
  }
  if (detail) out.parameters = entry.parameters || null;
  return out;
}

function matches(entry, { search, capability, min_context, include_combos }) {
  if (include_combos === false && entry.owned_by === "combo") return false;
  if (min_context && !(entry.context_length >= min_context)) return false;
  for (const need of [capability].flat().filter(Boolean)) if (entry.capabilities?.[need] !== true) return false;
  if (!search) return true;
  const q = String(search).toLowerCase();
  return [entry.id, entry.name, entry.provider?.name].some((v) => typeof v === "string" && v.toLowerCase().includes(q));
}

const clampLimit = (n, fallback) => Math.min(MAX_LIMIT, Math.max(1, Number.isInteger(n) ? n : fallback));

async function listModels(args, { apiKey }) {
  const { idFormat, entries } = await catalog(apiKey);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const found = entries.filter((e) => e.owned_by !== "alias" && matches(e, args));
  const limit = clampLimit(args.limit, 50);
  return {
    id_format: idFormat,
    total: found.length,
    models: await Promise.all(found.slice(0, limit).map((e) => summarize(e, byId))),
    ...(found.length > limit ? { truncated: true } : {}),
  };
}

async function getModel({ id }, { apiKey }) {
  const { idFormat, entries } = await catalog(apiKey);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const entry = byId.get(id) || entries.find((e) => Array.isArray(e.aliases) && e.aliases.includes(id));
  if (!entry) throw new Error(`No model "${id}" for this API key. Use list_models to see what it can call.`);
  const out = await summarize(entry, byId, { detail: true });
  if (entry.members?.length) {
    out.member_details = await Promise.all(entry.members.map(async (m) => {
      const member = byId.get(m);
      return member ? summarize(member, byId) : { id: m, available: false };
    }));
  }
  return { id_format: idFormat, model: out };
}

async function listCombos(args, { apiKey }) {
  const { entries } = await catalog(apiKey);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const combos = entries.filter((e) => e.owned_by === "combo" && (args.include_flat === true || !e.flat));
  return { total: combos.length, combos: await Promise.all(combos.map((e) => summarize(e, byId))) };
}

function accountStatus(conn, now) {
  if (conn.isActive === false) return "disabled";
  if (conn.rateLimitedUntil && Date.parse(conn.rateLimitedUntil) > now) return "rate_limited";
  if (conn.testStatus && !["active", "success", "unknown"].includes(conn.testStatus)) return "error";
  return "ok";
}

async function listProviders(_args, { apiKey }) {
  const [connections, allowed, { entries }] = await Promise.all([
    getProviderConnections(),
    getApiKeyAllowedConnectionIds(apiKey),
    catalog(apiKey),
  ]);
  const now = Date.now();
  const names = new Map();
  const modelCounts = new Map();
  for (const e of entries) {
    if (!e.provider?.id || e.owned_by === "combo" || e.owned_by === "alias") continue;
    names.set(e.provider.id, e.provider.name || e.provider.id);
    modelCounts.set(e.provider.id, (modelCounts.get(e.provider.id) || 0) + 1);
  }
  const byProvider = new Map();
  for (const conn of connections) {
    if (allowed && !allowed.includes(conn.id)) continue;
    const p = byProvider.get(conn.provider) || { id: conn.provider, name: names.get(conn.provider) || conn.provider, accounts: { total: 0, ok: 0, rate_limited: 0, error: 0, disabled: 0 }, health: null, models: modelCounts.get(conn.provider) || 0 };
    p.accounts.total += 1;
    p.accounts[accountStatus(conn, now)] += 1;
    const health = summarizeConnectionHealth(conn.id, now);
    if (health) {
      const h = p.health || { samples: 0, error_rate: 0, ttft_ms: null };
      const samples = h.samples + health.samples;
      h.error_rate = Math.round(((h.error_rate * h.samples) + (health.errorRate * health.samples)) / samples * 1000) / 1000;
      h.ttft_ms = health.ttftMs === null ? h.ttft_ms : h.ttft_ms === null ? health.ttftMs : Math.min(h.ttft_ms, health.ttftMs);
      h.samples = samples;
      p.health = h;
    }
    byProvider.set(conn.provider, p);
  }
  const providers = [...byProvider.values()].map((p) => ({ ...p, usable: p.accounts.ok > 0 }));
  return { total: providers.length, providers: providers.sort((a, b) => a.name.localeCompare(b.name)) };
}

async function recommendModels(args, context) {
  const { entries, idFormat } = await catalog(context.apiKey);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const needs = Array.isArray(args.needs) ? args.needs : [];
  const candidates = entries.filter((e) => e.owned_by !== "alias" && matches(e, { capability: needs, min_context: args.min_context, include_combos: args.include_combos }));
  const scored = [];
  for (const entry of candidates) {
    const summary = await summarize(entry, byId);
    const price = total(summary.price_per_million);
    if (args.max_price_per_million !== undefined && (price === null || price > args.max_price_per_million)) continue;
    if (args.free_only && price !== 0 && !String(entry.id).match(/(:free|-free)$/)) continue;
    scored.push({ summary, price });
  }
  const prefer = args.prefer || "cheapest";
  scored.sort((a, b) => {
    if (prefer === "largest_context") return (b.summary.context_length || 0) - (a.summary.context_length || 0) || (a.price ?? Infinity) - (b.price ?? Infinity);
    // cheapest: unknown prices last; ties go to the larger context.
    return (a.price ?? Infinity) - (b.price ?? Infinity) || (b.summary.context_length || 0) - (a.summary.context_length || 0);
  });
  const limit = clampLimit(args.limit, 5);
  return {
    id_format: idFormat,
    criteria: { needs, min_context: args.min_context ?? null, max_price_per_million: args.max_price_per_million ?? null, free_only: !!args.free_only, prefer },
    considered: candidates.length,
    recommendations: scored.slice(0, limit).map(({ summary }) => ({
      ...summary,
      why: [
        needs.length ? `has ${needs.join(", ")}` : null,
        summary.context_length ? `${summary.context_length.toLocaleString("en-US")} tokens of context` : null,
        summary.price_per_million ? `$${summary.price_per_million.input ?? "?"} in / $${summary.price_per_million.output ?? "?"} out per 1M` : "price unknown",
        summary.kind === "combo" || summary.kind === "flat" ? `falls back across ${summary.members.length} member(s)` : null,
      ].filter(Boolean).join("; "),
    })),
    note: "Suggestions only: switch by sending this id as `model`, after the user agrees.",
  };
}

async function getUsage(args, { apiKey }) {
  if (!apiKey) throw new Error("get_usage needs an API key: it reports that key's own usage.");
  const hours = Math.min(720, Math.max(1, Number.isFinite(args.hours) ? args.hours : 24));
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const db = await getDb();
  const rows = await db.selectFrom("usageHistory").select(["model", "provider", "cost", "status", "tokens"])
    .where("apiKey", "=", apiKey).where("timestamp", ">=", since).execute();
  const byModel = new Map();
  const totals = { requests: 0, errors: 0, prompt_tokens: 0, completion_tokens: 0, cost: 0 };
  for (const row of rows) {
    let t = {};
    try { t = JSON.parse(row.tokens || "{}") || {}; } catch { /* keep zeros */ }
    const prompt = t.prompt_tokens || t.input_tokens || 0;
    const completion = t.completion_tokens || t.output_tokens || 0;
    const failed = row.status && row.status !== "ok" && row.status !== "success";
    totals.requests += 1;
    if (failed) totals.errors += 1;
    totals.prompt_tokens += prompt;
    totals.completion_tokens += completion;
    totals.cost += row.cost || 0;
    const key = `${row.provider || "?"}/${row.model}`;
    const m = byModel.get(key) || { model: row.model, provider: row.provider || null, requests: 0, errors: 0, prompt_tokens: 0, completion_tokens: 0, cost: 0 };
    m.requests += 1;
    if (failed) m.errors += 1;
    m.prompt_tokens += prompt;
    m.completion_tokens += completion;
    m.cost += row.cost || 0;
    byModel.set(key, m);
  }
  const round = (n) => Math.round(n * 1e6) / 1e6;
  const [policy, month] = await Promise.all([getApiKeyPolicy(apiKey), getApiKeyUsageTotals(apiKey)]);
  return {
    hours,
    totals: { ...totals, cost: round(totals.cost) },
    by_model: [...byModel.values()].sort((a, b) => b.cost - a.cost || b.requests - a.requests).slice(0, 20).map((m) => ({ ...m, cost: round(m.cost) })),
    limits: policy.limits || null,
    this_month: { cost: round(month.costThisMonth), tokens_today: month.tokensToday },
  };
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const capabilityEnum = { type: "string", enum: CAPABILITIES };

export const RED_ROUTER_TOOLS = [
  {
    name: "list_models",
    title: "List models",
    description: "Models and combos this API key can call through RedRouter, with context size, capabilities, thinking levels and price per 1M tokens. Use the returned `id` as the `model` of a request.",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Case-insensitive match on id, name or provider." },
        capability: { ...capabilityEnum, description: "Only models with this capability." },
        min_context: { type: "integer", minimum: 1, description: "Only models with at least this many tokens of context." },
        include_combos: { type: "boolean", description: "Include combos (default true)." },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: "At most this many (default 50)." },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    run: listModels,
  },
  {
    name: "get_model",
    title: "Get model",
    description: "One model or combo by id: capabilities, parameters, price, and for a combo or flat model each member in the order they are tried.",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "A model or combo id from list_models." } }, required: ["id"], additionalProperties: false },
    annotations: READ_ONLY,
    run: getModel,
  },
  {
    name: "list_combos",
    title: "List combos",
    description: "Routing combos this API key can call: one name with several models behind it, tried by strategy (fallback, round-robin, ...).",
    inputSchema: { type: "object", properties: { include_flat: { type: "boolean", description: "Also list flat model ids (implicit fallback combos). Default false." } }, additionalProperties: false },
    annotations: READ_ONLY,
    run: listCombos,
  },
  {
    name: "list_providers",
    title: "List providers",
    description: "Connected providers this API key can reach: accounts by status (ok, rate_limited, error, disabled), recent health (error rate, time to first token) and how many models each serves.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READ_ONLY,
    run: listProviders,
  },
  {
    name: "recommend_models",
    title: "Recommend models",
    description: "Rank the models and combos this API key can call against requirements (capabilities, context, price). Returns suggestions with the reason; it changes nothing. Ask the user before switching the model you use.",
    inputSchema: {
      type: "object",
      properties: {
        needs: { type: "array", items: capabilityEnum, description: "Capabilities the task needs." },
        min_context: { type: "integer", minimum: 1 },
        max_price_per_million: { type: "number", minimum: 0, description: "Input + output USD per 1M tokens." },
        free_only: { type: "boolean" },
        prefer: { type: "string", enum: ["cheapest", "largest_context"], description: "Ranking (default cheapest)." },
        include_combos: { type: "boolean", description: "Default true." },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Default 5." },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    run: recommendModels,
  },
  {
    name: "get_usage",
    title: "Get usage",
    description: "This API key's own usage over the last hours: requests, errors, tokens and cost per model, plus its limits and this month's spend.",
    inputSchema: { type: "object", properties: { hours: { type: "integer", minimum: 1, maximum: 720, description: "Look-back window (default 24)." } }, additionalProperties: false },
    annotations: READ_ONLY,
    run: getUsage,
  },
];

export const RED_ROUTER_MCP_INSTRUCTIONS = [
  "RedRouter routes this client's requests across providers. These tools describe what the calling API key can use; they never change routing.",
  "To use another model or combo, send its id as the request's `model`. Suggest a switch to the user and wait for their confirmation before making it.",
].join(" ");
