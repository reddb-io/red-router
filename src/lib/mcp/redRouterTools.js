// RedRouter's own MCP tools: read-only views of what the calling API key can
// use (models, combos, flat models, providers) and what it has spent, so an
// agent can suggest a better model or combo. Nothing here changes routing: a
// client applies a suggestion by sending a different `model`, after its user
// agrees. Every view is the one /v1/models gives the same key; provider views
// carry counts and health, never account names, e-mails or credentials.
//
// Result shapes are versioned by MCP_SCHEMA_VERSION (sent as the
// x-redrouter-mcp-version header and in initialize's _meta); bump it when a
// shape changes so clients can feature-detect. Failures are isError results
// whose structuredContent is { error: { code, message } } with a stable code.
import { getProviderConnections, getApiKeyAllowedConnectionIds } from "@/lib/localDb";
import { getApiKeyModelIdFormat, getApiKeyPolicy } from "@/lib/db/repos/apiKeysRepo.js";
import { getApiKeyUsageTotals } from "@/lib/db/repos/usageRepo.js";
import { getPricingForModel } from "@/lib/db/repos/pricingRepo.js";
import { getDb } from "@/lib/db/kysely.js";
import { offerOf } from "@/lib/flatModels.js";
import { summarizeConnectionHealth } from "open-sse/services/providerHealth.js";
import { PROVIDER_ID_TO_ALIAS } from "open-sse/config/providerModels.js";

export const MCP_SCHEMA_VERSION = 2;
const CAPABILITIES = ["vision", "tools", "reasoning", "pdf", "search", "imageOutput", "audioInput", "audioOutput", "videoInput"];
const MAX_LIMIT = 500;
const FREE_ID = /(:free|-free)$/i;
// An error rate at or above this reads as an unhealthy provider.
const UNHEALTHY_ERROR_RATE = 0.3;
const ALIAS_TO_ID = Object.fromEntries(Object.entries(PROVIDER_ID_TO_ALIAS).map(([id, alias]) => [alias, id]));

/** A failure the client can branch on: unknown_model, forbidden, invalid_argument. */
export class ToolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function catalog(apiKey) {
  const { buildModelsList } = await import("@/app/api/v1/models/route.js");
  const idFormat = await getApiKeyModelIdFormat(apiKey);
  const entries = await buildModelsList(["llm"], { apiKey, idFormat });
  return { idFormat, entries, byId: new Map(entries.map((e) => [e.id, e])) };
}

const kindOf = (e) => (e.flat ? "flat" : e.owned_by === "combo" ? "combo" : e.owned_by === "alias" ? "alias" : "model");
const capabilityList = (caps) => CAPABILITIES.filter((c) => caps?.[c] === true);
const perMillion = (p) => (p && (typeof p.input === "number" || typeof p.output === "number")
  ? { input: p.input ?? null, output: p.output ?? null } : null);
const total = (price) => (price ? (price.input || 0) + (price.output || 0) : null);

function accountStatus(conn, now) {
  if (conn.isActive === false) return "disabled";
  if (conn.rateLimitedUntil && Date.parse(conn.rateLimitedUntil) > now) return "rate_limited";
  if (conn.testStatus && !["active", "success", "unknown"].includes(conn.testStatus)) return "error";
  return "ok";
}

/**
 * Provider id -> { accounts, health, status } over the connections this key may use.
 * status: { state: ok|rate_limited|error|disabled, until?, error_rate? }
 */
async function providerStates(apiKey) {
  const [connections, allowed] = await Promise.all([getProviderConnections(), getApiKeyAllowedConnectionIds(apiKey)]);
  const now = Date.now();
  const byProvider = new Map();
  for (const conn of connections) {
    if (allowed && !allowed.includes(conn.id)) continue;
    const p = byProvider.get(conn.provider) || { accounts: { total: 0, ok: 0, rate_limited: 0, error: 0, disabled: 0 }, health: null, until: null };
    const state = accountStatus(conn, now);
    p.accounts.total += 1;
    p.accounts[state] += 1;
    if (state === "rate_limited" && (!p.until || conn.rateLimitedUntil < p.until)) p.until = conn.rateLimitedUntil;
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
  for (const p of byProvider.values()) {
    const { accounts } = p;
    const state = accounts.ok ? "ok" : accounts.rate_limited ? "rate_limited" : accounts.error ? "error" : "disabled";
    p.status = {
      state,
      ...(state === "rate_limited" && p.until ? { until: p.until } : {}),
      ...(p.health ? { error_rate: p.health.error_rate } : {}),
    };
  }
  return byProvider;
}

/** The connection-level status behind a concrete model entry. */
function statusOfModel(entry, states) {
  for (const id of [ALIAS_TO_ID[entry.owned_by], entry.owned_by, entry.provider?.id]) {
    if (id && states.has(id)) return states.get(id).status;
  }
  return { state: "unknown" };
}

const usableState = (status) => status.state === "ok" || status.state === "unknown";

/** USD per 1M tokens for a concrete model, from RedRouter's pricing table. */
async function priceOf(entry) {
  const offer = offerOf(entry);
  if (!offer?.modelId) return null;
  return perMillion(await getPricingForModel(offer.providerId, offer.modelId).catch(() => null));
}

function membersOf(entry) {
  if (entry.flat) return (entry.offers || []).filter((o) => o.available !== false).map((o) => o.id);
  return entry.members || [];
}

async function summarize(entry, ctx, { detail = false } = {}) {
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
  };
  if (kind === "combo" || kind === "flat") {
    // A combo is usable when a member it would try is; its price and status are the first usable member's.
    const members = membersOf(entry);
    const memberStates = members.map((id) => {
      const m = ctx.byId.get(id);
      return { id, entry: m, status: m ? statusOfModel(m, ctx.states) : { state: "unknown" } };
    });
    const lead = memberStates.find((m) => m.entry && usableState(m.status)) || memberStates[0];
    out.strategy = entry.strategy || "fallback";
    out.members = entry.members || members;
    out.status = lead ? lead.status : { state: "unknown" };
    out.usable = memberStates.some((m) => usableState(m.status));
    out.price_per_million = kind === "flat"
      ? (entry.offers || []).find((o) => o.id === lead?.id)?.price || null
      : lead?.entry ? await priceOf(lead.entry) : null;
    out.free = total(out.price_per_million) === 0 || FREE_ID.test(entry.id);
    if (kind === "flat") {
      out.offers = (entry.offers || []).map((o) => ({
        id: o.id, pin_id: o.pin_id ?? null, provider: o.provider?.name || o.provider?.id,
        available: o.available !== false, price: o.price, free: !!o.free,
      }));
    }
  } else {
    out.status = statusOfModel(entry, ctx.states);
    out.usable = usableState(out.status);
    out.price_per_million = await priceOf(entry);
    out.free = total(out.price_per_million) === 0 || FREE_ID.test(entry.id);
  }
  if (entry.variants) out.variants = entry.variants;
  if (detail) out.parameters = entry.parameters || null;
  return out;
}

function findEntry(id, ctx) {
  const entry = ctx.byId.get(id) || ctx.entries.find((e) => Array.isArray(e.aliases) && e.aliases.includes(id));
  if (!entry) throw new ToolError("unknown_model", `No model "${id}" for this API key. Use list_models to see what it can call.`);
  return entry;
}

function matches(entry, { search, capability, min_context, include_combos }) {
  if (include_combos === false && entry.owned_by === "combo") return false;
  if (min_context && !(entry.context_length >= min_context)) return false;
  for (const need of [capability].flat().filter(Boolean)) if (entry.capabilities?.[need] !== true) return false;
  if (!search) return true;
  const q = String(search).toLowerCase();
  return [entry.id, entry.name, entry.provider?.name].some((v) => typeof v === "string" && v.toLowerCase().includes(q));
}

const clampLimit = (n, fallback, max = MAX_LIMIT) => Math.min(max, Math.max(1, Number.isInteger(n) ? n : fallback));

async function context(apiKey) {
  const [cat, states] = await Promise.all([catalog(apiKey), providerStates(apiKey)]);
  return { ...cat, states };
}

async function listModels(args, { apiKey }) {
  const ctx = await context(apiKey);
  const found = ctx.entries.filter((e) => e.owned_by !== "alias" && matches(e, args));
  const limit = clampLimit(args.limit, 50);
  return {
    id_format: ctx.idFormat,
    total: found.length,
    models: await Promise.all(found.slice(0, limit).map((e) => summarize(e, ctx))),
    ...(found.length > limit ? { truncated: true } : {}),
  };
}

async function getModel({ id }, { apiKey }) {
  const ctx = await context(apiKey);
  const entry = findEntry(id, ctx);
  const out = await summarize(entry, ctx, { detail: true });
  if (entry.members?.length) {
    out.member_details = await Promise.all(entry.members.map(async (m) => {
      const member = ctx.byId.get(m);
      return member ? summarize(member, ctx) : { id: m, usable: false, status: { state: "unknown" } };
    }));
  }
  return { id_format: ctx.idFormat, model: out };
}

async function listCombos(args, { apiKey }) {
  const ctx = await context(apiKey);
  const combos = ctx.entries.filter((e) => e.owned_by === "combo" && (args.include_flat === true || !e.flat));
  return { total: combos.length, combos: await Promise.all(combos.map((e) => summarize(e, ctx))) };
}

async function listProviders(_args, { apiKey }) {
  const ctx = await context(apiKey);
  const names = new Map();
  const modelCounts = new Map();
  for (const e of ctx.entries) {
    if (!e.provider?.id || e.owned_by === "combo" || e.owned_by === "alias") continue;
    const id = ALIAS_TO_ID[e.owned_by] || e.owned_by;
    if (e.provider.id === id) names.set(id, e.provider.name || id);
    modelCounts.set(id, (modelCounts.get(id) || 0) + 1);
  }
  const providers = [...ctx.states.entries()].map(([id, p]) => ({
    id,
    name: names.get(id) || id,
    accounts: p.accounts,
    status: p.status,
    usable: p.accounts.ok > 0,
    health: p.health,
    models: modelCounts.get(id) || 0,
  }));
  return { total: providers.length, providers: providers.sort((a, b) => a.name.localeCompare(b.name)) };
}

/** How `candidate` compares to `current`, so a client never suggests a downgrade unknowingly. */
function deltaVs(current, candidate) {
  const cur = total(current.price_per_million);
  const next = total(candidate.price_per_million);
  return {
    price_delta_pct: cur && next !== null ? Math.round(((next - cur) / cur) * 1000) / 10 : null,
    context_delta: current.context_length !== null && candidate.context_length !== null ? candidate.context_length - current.context_length : null,
    gained_capabilities: candidate.capabilities.filter((c) => !current.capabilities.includes(c)),
    lost_capabilities: current.capabilities.filter((c) => !candidate.capabilities.includes(c)),
  };
}

function reasonsFor(candidate, { needs, needsTokens, current, delta }) {
  const reasons = [];
  for (const need of needs) reasons.push({ code: need, detail: `supports ${need}` });
  if (needsTokens && candidate.context_length) reasons.push({ code: "context", detail: `${candidate.context_length.toLocaleString("en-US")} tokens of context fit ${needsTokens.toLocaleString("en-US")} in use` });
  if (candidate.free) reasons.push({ code: "free", detail: "no cost per token" });
  if (current && delta) {
    if (delta.price_delta_pct !== null && delta.price_delta_pct < 0) reasons.push({ code: "cheaper", detail: `${Math.abs(delta.price_delta_pct)}% cheaper than ${current.id}` });
    if (delta.context_delta > 0) reasons.push({ code: "larger_context", detail: `${delta.context_delta.toLocaleString("en-US")} more tokens of context than ${current.id}` });
    for (const c of delta.gained_capabilities) if (!needs.includes(c)) reasons.push({ code: c, detail: `adds ${c}, which ${current.id} lacks` });
    if (!current.usable) {
      reasons.push(current.status.state === "rate_limited"
        ? { code: "rate_limited", detail: `${current.id} is rate limited${current.status.until ? ` until ${current.status.until}` : ""}` }
        : { code: "provider_unhealthy", detail: `${current.id} has no usable account (${current.status.state})` });
    } else if ((current.status.error_rate ?? 0) >= UNHEALTHY_ERROR_RATE && (candidate.status.error_rate ?? 0) < (current.status.error_rate ?? 0)) {
      reasons.push({ code: "provider_unhealthy", detail: `${current.id} fails ${Math.round(current.status.error_rate * 100)}% of requests lately` });
    }
  }
  if (candidate.kind === "combo" || candidate.kind === "flat") reasons.push({ code: "fallback", detail: `falls back across ${candidate.members.length} member(s)` });
  return reasons;
}

async function recommendModels(args, { apiKey }) {
  const ctx = await context(apiKey);
  let needs = Array.isArray(args.needs) ? [...new Set(args.needs)] : [];
  const current = args.current ? await summarize(findEntry(args.current, ctx), ctx) : null;
  const reference = args.equivalent_to ? await summarize(findEntry(args.equivalent_to, ctx), ctx) : null;
  let minContext = Math.max(args.min_context || 0, args.needs_input_tokens || 0);
  if (reference) {
    // An equivalent keeps every capability and at least the context of the reference.
    needs = [...new Set([...needs, ...reference.capabilities])];
    minContext = Math.max(minContext, reference.context_length || 0);
  }
  const candidates = ctx.entries.filter((e) => e.owned_by !== "alias"
    && e.id !== current?.id && e.id !== reference?.id
    && matches(e, { capability: needs, min_context: minContext || undefined, include_combos: args.include_combos }));

  const scored = [];
  for (const entry of candidates) {
    const summary = await summarize(entry, ctx);
    // Never point at something that cannot serve right now.
    if (!summary.usable) continue;
    const price = total(summary.price_per_million);
    if (args.max_price_per_million !== undefined && (price === null || price > args.max_price_per_million)) continue;
    if (args.free_only && !summary.free) continue;
    if (reference && args.prefer !== "largest_context") {
      // An equivalent has to be cheaper or healthier than the reference to be worth a switch.
      const refPrice = total(reference.price_per_million);
      const cheaper = refPrice !== null && price !== null && price < refPrice;
      const healthier = !reference.usable || (summary.status.error_rate ?? 0) < (reference.status.error_rate ?? 0);
      if (!cheaper && !healthier) continue;
    }
    scored.push({ summary, price });
  }
  const prefer = args.prefer || "cheapest";
  scored.sort((a, b) => {
    if (prefer === "largest_context") return (b.summary.context_length || 0) - (a.summary.context_length || 0) || (a.price ?? Infinity) - (b.price ?? Infinity);
    // cheapest: unknown prices last; ties go to the larger context.
    return (a.price ?? Infinity) - (b.price ?? Infinity) || (b.summary.context_length || 0) - (a.summary.context_length || 0);
  });
  const limit = clampLimit(args.limit, 5, 50);
  const base = current || reference;
  return {
    id_format: ctx.idFormat,
    criteria: {
      needs, min_context: minContext || null, needs_input_tokens: args.needs_input_tokens ?? null,
      max_price_per_million: args.max_price_per_million ?? null, free_only: !!args.free_only, prefer,
      current: current?.id ?? null, equivalent_to: reference?.id ?? null,
    },
    ...(current ? { current } : {}),
    considered: candidates.length,
    recommendations: scored.slice(0, limit).map(({ summary }) => {
      const delta = base ? deltaVs(base, summary) : null;
      const why = reasonsFor(summary, { needs, needsTokens: args.needs_input_tokens, current: base, delta });
      return { ...summary, ...(delta ? { delta } : {}), why, why_text: why.map((r) => r.detail).join("; ") };
    }),
    note: "Suggestions only: switch by sending this id as `model`, after the user agrees.",
  };
}

async function getUsage(args, { apiKey }) {
  if (!apiKey) throw new ToolError("forbidden", "get_usage needs an API key: it reports that key's own usage.");
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
    const key = `${row.provider || "?"}/${row.model}`;
    const m = byModel.get(key) || { model: row.model, provider: row.provider || null, requests: 0, errors: 0, prompt_tokens: 0, completion_tokens: 0, cost: 0 };
    for (const agg of [totals, m]) {
      agg.requests += 1;
      if (failed) agg.errors += 1;
      agg.prompt_tokens += prompt;
      agg.completion_tokens += completion;
      agg.cost += row.cost || 0;
    }
    byModel.set(key, m);
  }
  const round = (n) => Math.round(n * 1e6) / 1e6;
  const [policy, month] = await Promise.all([getApiKeyPolicy(apiKey), getApiKeyUsageTotals(apiKey)]);
  const limits = policy.limits || null;
  return {
    currency: "USD",
    hours,
    totals: { ...totals, cost: round(totals.cost) },
    by_model: [...byModel.values()].sort((a, b) => b.cost - a.cost || b.requests - a.requests).slice(0, 20).map((m) => ({ ...m, cost: round(m.cost) })),
    limits,
    this_month: { cost: round(month.costThisMonth), tokens_today: month.tokensToday },
    remaining: {
      usd_this_month: limits?.usdPerMonth ? round(Math.max(0, limits.usdPerMonth - month.costThisMonth)) : null,
      tokens_today: limits?.tokensPerDay ? Math.max(0, limits.tokensPerDay - month.tokensToday) : null,
    },
  };
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const capabilityEnum = { type: "string", enum: CAPABILITIES };
const SUMMARY_NOTE = "Each model carries status ({state: ok|rate_limited|error|disabled|unknown, until?, error_rate?}), usable, free and, for flat models, offers with pin_id.";

export const RED_ROUTER_TOOLS = [
  {
    name: "list_models",
    title: "List models",
    description: `Models and combos this API key can call through RedRouter, with context size, capabilities, thinking levels and price per 1M tokens (USD). Use the returned \`id\` as the \`model\` of a request. ${SUMMARY_NOTE}`,
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
    description: "One model or combo by id: capabilities, parameters, price, status, and for a combo or flat model each member in the order they are tried. Unknown ids fail with code unknown_model.",
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
    description: "Connected providers this API key can reach: accounts by status (ok, rate_limited, error, disabled), overall status, recent health (error rate, time to first token) and how many models each serves.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READ_ONLY,
    run: listProviders,
  },
  {
    name: "recommend_models",
    title: "Recommend models",
    description: [
      "Rank the usable models and combos this API key can call against requirements; it changes nothing. Ask the user before switching.",
      "Pass `current` (the model in use) to get a `delta` per suggestion (price_delta_pct, context_delta, gained/lost capabilities) and reasons about the current model's health.",
      "Pass `equivalent_to` to find models with the same capabilities and at least the same context that are cheaper or healthier.",
      "Map a session's needs yourself: images in context → vision, tool calls → tools; `needs_input_tokens` is the context already in use.",
      "Each suggestion has `why`: [{code, detail}] with codes vision|tools|reasoning|pdf|search|context|larger_context|cheaper|free|rate_limited|provider_unhealthy|fallback, and `why_text`.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        needs: { type: "array", items: capabilityEnum, description: "Capabilities the task needs." },
        current: { type: "string", description: "The model id in use now." },
        equivalent_to: { type: "string", description: "Find cheaper or healthier equivalents of this model id." },
        min_context: { type: "integer", minimum: 1 },
        needs_input_tokens: { type: "integer", minimum: 1, description: "Tokens the session already needs in context." },
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
    description: "This API key's own usage over the last hours (USD): requests, errors, tokens and cost per model, plus its limits, this month's spend and what remains. Without an API key it fails with code forbidden.",
    inputSchema: { type: "object", properties: { hours: { type: "integer", minimum: 1, maximum: 720, description: "Look-back window (default 24)." } }, additionalProperties: false },
    annotations: READ_ONLY,
    run: getUsage,
  },
];

export const RED_ROUTER_MCP_INSTRUCTIONS = [
  "RedRouter routes this client's requests across providers. These tools describe what the calling API key can use; they never change routing.",
  "To use another model or combo, send its id as the request's `model`. Suggest a switch to the user and wait for their confirmation before making it.",
].join(" ");
