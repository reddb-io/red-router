export type JevRoutingConfig = {
  mode: "off" | "jev";
  model: string;
};

/** Null means no key restriction; [] means a quota/key scope with no usable connection. */
export function restrictJevConnections(
  allowedConnections: string[] | null,
  quotaConnectionIds: string[] | null
): string[] | null {
  if (quotaConnectionIds === null) return allowedConnections;
  if (!allowedConnections) return quotaConnectionIds;
  return allowedConnections.filter((id) => quotaConnectionIds.includes(id));
}

/** Persisted auto-combo decision settings; absent means no network evaluation. */
export function parseJevRoutingConfig(combo: {
  autoConfig?: Record<string, unknown> | null;
  config?: Record<string, unknown> | null;
}): JevRoutingConfig {
  const auto = combo.config?.auto;
  const nested =
    combo.autoConfig?.decision ??
    (auto && typeof auto === "object" && !Array.isArray(auto)
      ? (auto as Record<string, unknown>).decision
      : null) ??
    combo.config?.decision;
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) {
    return { mode: "off", model: "typesafe-ai/jev-latest" };
  }
  const config = nested as Record<string, unknown>;
  return {
    mode: config.mode === "jev" ? "jev" : "off",
    model:
      typeof config.model === "string" && config.model.trim()
        ? config.model.trim()
        : "typesafe-ai/jev-latest",
  };
}
