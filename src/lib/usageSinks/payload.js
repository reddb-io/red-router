// Payloads a usage sink sends. Versioned: consumers switch on `type` and
// `version`, and should treat unknown fields as additive.
//
//   usage.recorded — one request (instant mode)
//   usage.window   — per-API-key totals for a clock-aligned window (window mode)
//
// API keys travel as id / name / masked / tags, never the raw key. A key that
// no longer exists is identified by a stable one-way fingerprint.
import { createHash } from "node:crypto";
import { maskApiKey } from "@/lib/db/helpers/maskKey.js";

export const PAYLOAD_VERSION = 1;

const shortHash = (value) => createHash("sha256").update(String(value)).digest("hex").slice(0, 24);

/** Deterministic ids: the same range for the same sink always yields the same id. */
export const windowBatchId = (sinkId, fromId, toId) => `ub_${shortHash(`${sinkId}:${fromId}:${toId}`)}`;
export const eventBatchId = (sinkId, rowId) => `ue_${shortHash(`${sinkId}:${rowId}`)}`;

/** raw key → { id, name, masked, tags } using the current API keys. */
export function buildKeyResolver(apiKeys = []) {
  const byKey = new Map(apiKeys.map((k) => [k.key, k]));
  return (rawKey) => {
    if (!rawKey) return null;
    const key = byKey.get(rawKey);
    if (key) return { id: key.id, name: key.name || null, masked: maskApiKey(rawKey), tags: key.tags || [] };
    return { id: null, name: null, masked: maskApiKey(rawKey), tags: [], fingerprint: `fp_${shortHash(rawKey)}` };
  };
}

/**
 * Whether a usage row belongs to the sink's filter. No filter: every row,
 * requests without a key included. With a filter, only keyed rows whose key id
 * is listed or carries one of the tags.
 */
export function matchesFilter(filter, identity) {
  const ids = filter?.apiKeyIds?.length ? filter.apiKeyIds : null;
  const tags = filter?.tags?.length ? filter.tags.map((t) => t.toLowerCase()) : null;
  if (!ids && !tags) return true;
  if (!identity?.id) return false;
  if (ids && ids.includes(identity.id)) return true;
  if (tags && identity.tags.some((t) => tags.includes(String(t).toLowerCase()))) return true;
  return false;
}

export function rowTokens(row) {
  const t = row.tokens || {};
  return {
    promptTokens: Number(row.promptTokens || t.prompt_tokens || t.input_tokens || 0),
    completionTokens: Number(row.completionTokens || t.completion_tokens || t.output_tokens || 0),
    cachedTokens: Number(t.cached_tokens || t.cache_read_input_tokens || t.prompt_tokens_details?.cached_tokens || 0),
  };
}

const isError = (row) => !!row.status && row.status !== "ok";

export function buildEventPayload({ sink, row, identity, id }) {
  return {
    type: "usage.recorded",
    version: PAYLOAD_VERSION,
    id,
    sink: { id: sink.id, name: sink.name },
    event: {
      usageId: row.id,
      timestamp: row.timestamp,
      apiKey: identity,
      provider: row.provider || null,
      model: row.model || null,
      endpoint: row.endpoint || null,
      status: row.status || "ok",
      tokens: rowTokens(row),
      cost: Number(row.cost || 0),
    },
  };
}

const emptyTotals = () => ({ requests: 0, errors: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 });

function addRow(totals, row) {
  const t = rowTokens(row);
  totals.requests += 1;
  if (isError(row)) totals.errors += 1;
  totals.promptTokens += t.promptTokens;
  totals.completionTokens += t.completionTokens;
  totals.cachedTokens += t.cachedTokens;
  totals.cost += Number(row.cost || 0);
}

/** Consolidate rows per API key, with a per provider/model breakdown. */
export function buildWindowPayload({ sink, rows, resolveKey, window, range, id }) {
  const groups = new Map();
  for (const row of rows) {
    const identity = resolveKey(row.apiKey);
    const groupKey = identity ? (identity.id || identity.fingerprint) : "__no_key__";
    if (!groups.has(groupKey)) groups.set(groupKey, { apiKey: identity, totals: emptyTotals(), byModel: new Map() });
    const g = groups.get(groupKey);
    addRow(g.totals, row);
    const modelKey = `${row.provider || ""}|${row.model || ""}`;
    if (!g.byModel.has(modelKey)) g.byModel.set(modelKey, { provider: row.provider || null, model: row.model || null, ...emptyTotals() });
    addRow(g.byModel.get(modelKey), row);
  }
  return {
    type: "usage.window",
    version: PAYLOAD_VERSION,
    id,
    sink: { id: sink.id, name: sink.name },
    window,
    range,
    keys: [...groups.values()].map((g) => ({
      apiKey: g.apiKey,
      totals: g.totals,
      byModel: [...g.byModel.values()],
    })),
  };
}

/** A made-up window, for the dashboard's "Send test" button. */
export function buildSamplePayload(sink, id) {
  const now = Date.now();
  const size = sink.windowSec || 900;
  const end = Math.floor(now / (size * 1000)) * size * 1000;
  const sampleKey = { id: "ak_sample", name: "sample-key", masked: "sk-sampl***1234", tags: ["sample"] };
  if (sink.mode === "instant") {
    return {
      type: "usage.recorded", version: PAYLOAD_VERSION, id, test: true,
      sink: { id: sink.id, name: sink.name },
      event: {
        usageId: 0, timestamp: new Date(now).toISOString(), apiKey: sampleKey,
        provider: "openai", model: "gpt-4o-mini", endpoint: "/v1/chat/completions", status: "ok",
        tokens: { promptTokens: 1200, completionTokens: 300, cachedTokens: 0 }, cost: 0.00036,
      },
    };
  }
  return {
    type: "usage.window", version: PAYLOAD_VERSION, id, test: true,
    sink: { id: sink.id, name: sink.name },
    window: { start: new Date(end - size * 1000).toISOString(), end: new Date(end).toISOString(), sizeSec: size },
    range: { fromId: 0, toId: 0 },
    keys: [{
      apiKey: sampleKey,
      totals: { requests: 3, errors: 0, promptTokens: 3600, completionTokens: 900, cachedTokens: 0, cost: 0.00108 },
      byModel: [{ provider: "openai", model: "gpt-4o-mini", requests: 3, errors: 0, promptTokens: 3600, completionTokens: 900, cachedTokens: 0, cost: 0.00108 }],
    }],
  };
}
