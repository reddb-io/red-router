export type WebhookEvent =
  | "request.completed"
  | "request.failed"
  | "quota.exceeded"
  | "budget.warning"
  | "proxy.set_aside"
  | "proxy.pool.exhausted"
  | "test.ping";

export const WEBHOOK_EVENT_VALUES = [
  "request.completed",
  "request.failed",
  "quota.exceeded",
  "budget.warning",
  "proxy.set_aside",
  "proxy.pool.exhausted",
  "test.ping",
] as const;

export interface EventDescription {
  label: string;
  description: string;
  emoji: string;
  exampleData: Record<string, unknown>;
}

export const EVENT_DESCRIPTIONS: Record<WebhookEvent, EventDescription> = {
  "request.completed": {
    label: "Request Completed",
    emoji: "✅",
    description: "Triggered when an upstream request completes successfully (HTTP 2xx).",
    exampleData: {
      model: "claude-opus-4-7",
      provider: "claude",
      latencyMs: 1240,
      tokensIn: 142,
      tokensOut: 38,
    },
  },
  "request.failed": {
    label: "Request Failed",
    emoji: "🚨",
    description: "Triggered when a request fails after all retries and fallback combo targets.",
    exampleData: {
      model: "claude-opus-4-7",
      provider: "claude",
      error: "503 Service Unavailable",
      attempts: 3,
    },
  },
  "quota.exceeded": {
    label: "Quota Exceeded",
    emoji: "📊",
    description: "A usage threshold (e.g. 95% of quota) was reached.",
    exampleData: { quota: "daily_tokens", used: 950000, limit: 1000000, pct: 95 },
  },
  "budget.warning": {
    label: "Budget Warning",
    emoji: "💸",
    description:
      "Triggered once per window when spend on a budget reaches its soft threshold. Carries ids and amounts only.",
    exampleData: {
      budgetId: "0b6f3c1e-1f4e-4a54-9d2a-6c7a2f1b9a10",
      budgetName: "Team monthly cap",
      scopeType: "group",
      scopeValue: "5d1c0a2e-3a55-4e0c-8a35-2b7c0f6e1c44",
      spentUsd: 80.4,
      softUsd: 80,
      maxUsd: 100,
      duration: "monthly",
      windowStart: "2026-09-01T00:00:00.000Z",
      resetAt: "2026-10-01T00:00:00.000Z",
    },
  },
  "proxy.set_aside": {
    label: "Proxy Set Aside",
    emoji: "🚧",
    description:
      "Triggered when a pool member is temporarily set aside after repeated refusals. Transition only, never per request.",
    exampleData: {
      reason: "ip_quota_429",
      setAsideUntil: "2026-09-24T12:40:00.000Z",
      durationMs: 60000,
      egressKeyMasked: "https://u***@ho***le:8080",
    },
  },
  "proxy.pool.exhausted": {
    label: "Proxy Pool Exhausted",
    emoji: "🪫",
    description:
      "Triggered when every member of a pool scope is set aside and selection falls back to fail-closed serving.",
    exampleData: {
      scope: "global",
      poolSize: 3,
      setAsideCount: 3,
      fallback: "fail-closed-serve",
    },
  },
  "test.ping": {
    label: "Test Ping",
    emoji: "🏓",
    description: "Manual test delivery to verify your webhook is reachable.",
    exampleData: { message: "Test ping from RedRouter", webhookId: "preview" },
  },
};
