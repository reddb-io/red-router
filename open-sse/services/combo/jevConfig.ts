export type JevRoutingConfig = {
  mode: "off" | "jev";
  model: string;
  toolMode: "off" | "hint" | "none" | "forced";
  modelMode: "off" | "jev";
  briefs?: Record<string, string>;
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

/** An optional evaluator may run only after its separate model/connection policy passes. */
export async function canEvaluateJevModel(
  config: JevRoutingConfig,
  allowedConnections: string[] | null,
  isModelAllowed: (model: string) => Promise<boolean>
): Promise<boolean> {
  if (config.mode !== "jev" || allowedConnections?.length === 0) return false;
  try {
    return (await isModelAllowed(config.model)) === true;
  } catch {
    return false;
  }
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
    return { mode: "off", model: "typesafe-ai/jev-latest", toolMode: "off", modelMode: "off" };
  }
  const config = nested as Record<string, unknown>;
  const rawBriefs = config.briefs;
  const briefs =
    rawBriefs && typeof rawBriefs === "object" && !Array.isArray(rawBriefs)
      ? Object.fromEntries(
          Object.entries(rawBriefs)
            .slice(0, 64)
            .filter(
              ([key, value]) =>
                key.trim().length > 0 &&
                key.length <= 200 &&
                typeof value === "string" &&
                value.trim().length > 0 &&
                value.length <= 600
            )
            .map(([key, value]) => [key.trim(), (value as string).trim()])
        )
      : {};
  return {
    mode: config.mode === "jev" ? "jev" : "off",
    model:
      typeof config.model === "string" && config.model.trim()
        ? config.model.trim()
        : "typesafe-ai/jev-latest",
    toolMode:
      config.toolMode === "hint" || config.toolMode === "none" || config.toolMode === "forced"
        ? config.toolMode
        : "off",
    modelMode: config.modelMode === "jev" ? "jev" : "off",
    ...(Object.keys(briefs).length > 0 ? { briefs } : {}),
  };
}
