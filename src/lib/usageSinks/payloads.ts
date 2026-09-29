/**
 * The payloads a usage sink delivers. Versioned: consumers switch on `type` and `version` and
 * should treat unknown fields as additive.
 *
 *   usage.recorded: one costed request (instant mode)
 *   usage.window:   per-API-key totals for a clock-aligned window (window mode)
 *
 * API keys travel as id and name, never the raw key. Every transport sends exactly these bodies;
 * only the envelope (webhook headers, SQS attributes, Kafka headers, RedDB DEDUP key) differs.
 */
import type { CostedUsageRow, UsageSink } from "@/lib/db/usageSinks";

export const PAYLOAD_VERSION = 1;

function keyIdentity(row: CostedUsageRow) {
  return { id: row.apiKeyId, name: row.apiKeyName };
}

export function eventPayload(sink: UsageSink, row: CostedUsageRow, id: string) {
  return {
    type: "usage.recorded",
    version: PAYLOAD_VERSION,
    id,
    source: "request_cost_ledger",
    coverage: "costed-requests-only",
    sink: { id: sink.id, name: sink.name },
    event: {
      usageId: row.id,
      requestId: row.requestId,
      timestamp: row.timestamp,
      apiKey: keyIdentity(row),
      provider: row.provider,
      model: row.model,
      status: row.success ? "ok" : "error",
      tokens: {
        promptTokens: row.tokensInput,
        completionTokens: row.tokensOutput,
        cachedTokens: row.tokensCacheRead,
      },
      cost: row.amountUsd,
    },
  };
}

type Totals = {
  requests: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cost: number;
};

const emptyTotals = (): Totals => ({
  requests: 0,
  errors: 0,
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  cost: 0,
});

function addRow(total: Totals, row: CostedUsageRow) {
  total.requests++;
  if (!row.success) total.errors++;
  total.promptTokens += row.tokensInput;
  total.completionTokens += row.tokensOutput;
  total.cachedTokens += row.tokensCacheRead;
  total.cost += row.amountUsd;
}

export function windowPayload(
  sink: UsageSink,
  rows: CostedUsageRow[],
  id: string,
  range: { fromId: number; toId: number },
  start: string,
  end: string
) {
  const groups = new Map<
    string,
    {
      apiKey: ReturnType<typeof keyIdentity>;
      totals: Totals;
      byModel: Map<string, Totals & { provider: string; model: string }>;
    }
  >();
  for (const row of rows) {
    let group = groups.get(row.apiKeyId);
    if (!group) {
      group = { apiKey: keyIdentity(row), totals: emptyTotals(), byModel: new Map() };
      groups.set(row.apiKeyId, group);
    }
    addRow(group.totals, row);
    const modelKey = JSON.stringify([row.provider, row.model]);
    let model = group.byModel.get(modelKey);
    if (!model) {
      model = { provider: row.provider, model: row.model, ...emptyTotals() };
      group.byModel.set(modelKey, model);
    }
    addRow(model, row);
  }
  return {
    type: "usage.window",
    version: PAYLOAD_VERSION,
    id,
    source: "request_cost_ledger",
    coverage: "costed-requests-only",
    sink: { id: sink.id, name: sink.name },
    window: { start, end, sizeSec: sink.windowSec },
    range,
    keys: [...groups.values()].map((group) => ({
      apiKey: group.apiKey,
      totals: group.totals,
      byModel: [...group.byModel.values()],
    })),
  };
}

/**
 * A made-up delivery for the dashboard's "Send test": the real builders over sample ledger rows
 * (so the shape can never drift from what is delivered), marked `test: true`.
 */
export function samplePayload(sink: UsageSink, id: string, at = new Date()) {
  const rows: CostedUsageRow[] = [1, 2, 3].map((n) => ({
    id: 0,
    apiKeyId: "key_sample",
    apiKeyName: "sample-key",
    provider: "openai",
    model: "gpt-4o-mini",
    tokensInput: 1200,
    tokensOutput: 300,
    tokensCacheRead: 0,
    amountUsd: 0.00036,
    success: true,
    timestamp: at.toISOString(),
    requestId: `req_sample_${n}`,
  }));
  if (sink.mode === "instant") return { ...eventPayload(sink, rows[0], id), test: true };
  const sizeMs = (sink.windowSec ?? 900) * 1000;
  const end = Math.floor(at.getTime() / sizeMs) * sizeMs;
  return {
    ...windowPayload(
      sink,
      rows,
      id,
      { fromId: 0, toId: 0 },
      new Date(end - sizeMs).toISOString(),
      new Date(end).toISOString()
    ),
    test: true,
  };
}
