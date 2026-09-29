/** RedRouter costed-usage webhook delivery: atomic outbox and at-least-once send. */
import { createHash, createHmac } from "node:crypto";
import { decrypt } from "@/lib/db/encryption";
import {
  claimUsageDelivery,
  commitUsageBatch,
  finishUsageDelivery,
  getUsageSink,
  listCostedUsageAfter,
  listDueUsageDeliveries,
  listUsageSinks,
  setNextUsageWindow,
  type CostedUsageRow,
  type UsageSink,
} from "@/lib/db/usageSinks";
import { fetchWebhookUrl } from "@/shared/network/webhookFetch";

const PAGE_SIZE = 500;
const BACKOFF_SECONDS = [30, 120, 600, 1800, 3600, 7200, 14400, 28800];

function deliveryId(prefix: string, sinkId: string, range: string): string {
  const digest = createHash("sha256").update(`${sinkId}:${range}`).digest("hex").slice(0, 24);
  return `${prefix}_${digest}`;
}

export function signUsageWebhook(
  id: string,
  timestamp: string,
  body: string,
  secret: string
): string {
  const bytes = secret.startsWith("whsec_")
    ? Buffer.from(secret.slice(6), "base64")
    : Buffer.from(secret, "utf8");
  return `v1,${createHmac("sha256", bytes).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

function keyIdentity(row: CostedUsageRow) {
  return { id: row.apiKeyId, name: row.apiKeyName };
}

function eventPayload(sink: UsageSink, row: CostedUsageRow, id: string) {
  return {
    type: "usage.recorded",
    version: 1,
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

function windowPayload(
  sink: UsageSink,
  rows: CostedUsageRow[],
  id: string,
  range: { fromId: number; toId: number },
  start: string,
  end: string
) {
  type Totals = {
    requests: number;
    errors: number;
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    cost: number;
  };
  const empty = (): Totals => ({
    requests: 0,
    errors: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    cost: 0,
  });
  const add = (total: Totals, row: CostedUsageRow) => {
    total.requests++;
    if (!row.success) total.errors++;
    total.promptTokens += row.tokensInput;
    total.completionTokens += row.tokensOutput;
    total.cachedTokens += row.tokensCacheRead;
    total.cost += row.amountUsd;
  };
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
      group = { apiKey: keyIdentity(row), totals: empty(), byModel: new Map() };
      groups.set(row.apiKeyId, group);
    }
    add(group.totals, row);
    const modelKey = JSON.stringify([row.provider, row.model]);
    let model = group.byModel.get(modelKey);
    if (!model) {
      model = { provider: row.provider, model: row.model, ...empty() };
      group.byModel.set(modelKey, model);
    }
    add(model, row);
  }
  return {
    type: "usage.window",
    version: 1,
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

function nextBoundary(nowMs: number, seconds: number): string {
  const size = seconds * 1000;
  return new Date((Math.floor(nowMs / size) + 1) * size).toISOString();
}

export function aggregateUsageSink(sink: UsageSink, now = new Date()): number {
  if (!sink.enabled) return 0;
  if (sink.mode === "window" && !sink.nextWindowEnd) {
    setNextUsageWindow(sink.id, nextBoundary(now.getTime(), sink.windowSec || 900));
    return 0;
  }
  if (sink.mode === "window" && Date.parse(sink.nextWindowEnd || "") > now.getTime()) return 0;

  const rows = listCostedUsageAfter(sink.cursorId, PAGE_SIZE);
  const lastId = rows.at(-1)?.id ?? sink.cursorId;
  const matched =
    sink.apiKeyIds.length === 0
      ? rows
      : rows.filter((row) => sink.apiKeyIds.includes(row.apiKeyId));
  const deliveries: Array<{ id: string; payload: Record<string, unknown> }> = [];
  let nextWindowEnd: string | undefined;
  if (sink.mode === "instant") {
    for (const row of matched) {
      const id = deliveryId("ue", sink.id, String(row.id));
      deliveries.push({ id, payload: eventPayload(sink, row, id) });
    }
  } else {
    const size = (sink.windowSec || 900) * 1000;
    const closedEnd = Math.floor(now.getTime() / size) * size;
    const start = new Date(Date.parse(sink.nextWindowEnd || "") - size).toISOString();
    const end = new Date(closedEnd).toISOString();
    // A full page may leave backlog. Keep this window open until all rows that
    // were present at the boundary have been converted into outbox deliveries.
    if (rows.length < PAGE_SIZE) nextWindowEnd = new Date(closedEnd + size).toISOString();
    if (matched.length > 0) {
      const range = { fromId: sink.cursorId + 1, toId: lastId };
      const id = deliveryId("ub", sink.id, `${range.fromId}:${range.toId}`);
      deliveries.push({ id, payload: windowPayload(sink, matched, id, range, start, end) });
    }
  }
  return commitUsageBatch(sink.id, sink.cursorId, lastId, deliveries, nextWindowEnd)
    ? deliveries.length
    : 0;
}

export async function dispatchUsageDeliveries(now = new Date()): Promise<number> {
  const due = listDueUsageDeliveries(now.toISOString(), 100);
  let attempted = 0;
  for (const delivery of due) {
    const sink = getUsageSink(delivery.sinkId);
    if (!sink?.enabled) continue;
    const leaseUntil = new Date(now.getTime() + 30_000).toISOString();
    if (!claimUsageDelivery(delivery.id, now.toISOString(), leaseUntil)) continue;
    attempted++;
    const attempts = delivery.attempts + 1;
    const secret = decrypt(sink.secretEncrypted);
    if (!secret) {
      finishUsageDelivery(delivery.id, {
        status: "dead",
        nextAttemptAt: null,
        httpStatus: null,
        error: "Webhook secret cannot be decrypted",
        deliveredAt: null,
      });
      continue;
    }
    const body = JSON.stringify(delivery.payload);
    const timestamp = String(Math.floor(now.getTime() / 1000));
    try {
      const { response } = await fetchWebhookUrl(
        sink.url,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": "RedRouter-UsageSinks/1",
            "webhook-id": delivery.id,
            "webhook-timestamp": timestamp,
            "webhook-signature": signUsageWebhook(delivery.id, timestamp, body, secret),
          },
          body,
        },
        { signal: AbortSignal.timeout(10_000), allowPrivate: false, maxRedirects: 0 }
      );
      await response.body?.cancel().catch(() => {});
      if (response.ok) {
        finishUsageDelivery(delivery.id, {
          status: "delivered",
          nextAttemptAt: null,
          httpStatus: response.status,
          error: null,
          deliveredAt: now.toISOString(),
        });
      } else {
        const dead = response.status === 410 || attempts > BACKOFF_SECONDS.length;
        finishUsageDelivery(delivery.id, {
          status: dead ? "dead" : "pending",
          nextAttemptAt: dead
            ? null
            : new Date(now.getTime() + BACKOFF_SECONDS[attempts - 1] * 1000).toISOString(),
          httpStatus: response.status,
          error: `HTTP ${response.status}`,
          deliveredAt: null,
        });
      }
    } catch {
      const dead = attempts > BACKOFF_SECONDS.length;
      finishUsageDelivery(delivery.id, {
        status: dead ? "dead" : "pending",
        nextAttemptAt: dead
          ? null
          : new Date(now.getTime() + BACKOFF_SECONDS[attempts - 1] * 1000).toISOString(),
        httpStatus: null,
        error: "Webhook request failed",
        deliveredAt: null,
      });
    }
  }
  return attempted;
}

export async function runUsageSinksTick(): Promise<{ created: number; attempted: number }> {
  let created = 0;
  for (const sink of listUsageSinks()) {
    if (!sink.enabled) continue;
    try {
      created += aggregateUsageSink(sink);
    } catch (error) {
      console.error(`[RedRouter UsageSinks] Aggregation failed for ${sink.id}:`, error);
    }
  }
  return { created, attempted: await dispatchUsageDeliveries() };
}
