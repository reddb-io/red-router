import type { RoutingPolicy } from "./routingPolicy";

export interface AccessPolicyInput {
  modelAccessMode: string;
  allowedModels: string[];
  blockedModels: string[];
  allowedConnections: string[];
  allowedEndpoints: string[];
  cacheDefaultMode: string;
  streamDefaultMode: string;
}

export interface EffectivePolicyRow {
  id: string;
  setting: string;
  value: string;
  source: string;
  explanation: string;
}

export interface EffectivePolicySnapshot {
  rows: EffectivePolicyRow[];
  access: {
    source: string;
    modelAccessMode: string;
    allowedModels: string[];
    blockedModels: string[];
    allowedEndpoints: string[];
  } | null;
  connections: {
    id: string;
    provider: string;
    name: string;
    enabled: boolean;
    cooldownUntil: string | null;
    testStatus: string | null;
  }[];
  connectionSource: string;
}

const SOURCE_LABELS = {
  instance: "Instance default",
  owner: "Owner pin for this tenant",
  tenant: "Tenant choice (delegated by owner)",
};

/** A projection of existing policy, never a second routing or credential selector. */
export function describeEffectivePolicy(
  policy: RoutingPolicy,
  configured: AccessPolicyInput | null,
  effective: AccessPolicyInput | null,
  connections: Record<string, unknown>[],
  now = Date.now()
): EffectivePolicySnapshot {
  const allowed = effective?.allowedConnections ?? [];
  const configuredIds = configured?.allowedConnections ?? [];
  const tenantNarrowed =
    allowed.length !== configuredIds.length || allowed.some((id) => !configuredIds.includes(id));
  const connectionSource = !effective
    ? "Instance catalog"
    : tenantNarrowed
      ? configuredIds.length > 0
        ? "API key intersected with tenant boundary"
        : "Tenant boundary"
      : configuredIds.length > 0
        ? "API key within tenant boundary"
        : "Instance catalog within tenant boundary";
  return {
    rows: [
      {
        id: "model-visibility",
        setting: "Model visibility",
        value: policy.transparent ? "Provider prefixes visible" : "Provider prefixes hidden",
        source: SOURCE_LABELS[policy.source.transparent],
        explanation: policy.transparent
          ? "The client selects a provider-qualified model."
          : "The router resolves the model against the authorized catalog.",
      },
      {
        id: "provider-order",
        setting: "Provider priority",
        value: policy.providerPriority.join(" → ") || "Catalog order",
        source: SOURCE_LABELS[policy.source.providerPriority],
        explanation: policy.transparent
          ? "This order applies when provider prefixes are hidden."
          : "Unlisted providers follow in catalog order; access restrictions still apply.",
      },
      {
        id: "cache-default",
        setting: "Chat response cache preference",
        value:
          effective?.cacheDefaultMode === "bypass" ? "Bypass" : "Follow instance cache settings",
        source: effective ? "API key" : "Instance default",
        explanation: "Request headers, payload and endpoint determine actual cache eligibility.",
      },
      {
        id: "stream-default",
        setting: "Chat streaming preference",
        value:
          effective?.streamDefaultMode === "json"
            ? "JSON by default"
            : "Standard endpoint behavior",
        source: effective ? "API key" : "Instance default",
        explanation: "An explicit stream parameter takes precedence over this default.",
      },
    ],
    access: effective
      ? {
          source: "API key within tenant boundary",
          modelAccessMode: effective.modelAccessMode,
          allowedModels: effective.allowedModels,
          blockedModels: effective.blockedModels,
          allowedEndpoints: effective.allowedEndpoints,
        }
      : null,
    connections: connections
      .filter((connection) => allowed.length === 0 || allowed.includes(String(connection.id)))
      .map((connection) => {
        const until =
          typeof connection.rateLimitedUntil === "string" ? connection.rateLimitedUntil : null;
        return {
          id: String(connection.id),
          provider: String(connection.provider),
          name: String(connection.name || connection.provider),
          enabled: connection.isActive !== false && connection.isActive !== 0,
          cooldownUntil: until && Date.parse(until) > now ? until : null,
          testStatus: typeof connection.testStatus === "string" ? connection.testStatus : null,
        };
      }),
    connectionSource,
  };
}
