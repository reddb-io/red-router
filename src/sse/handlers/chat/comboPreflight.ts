import { resolveCompressionSettings } from "@omniroute/open-sse/handlers/chatCore/compressionSettings.ts";
import { resolveComboTargets } from "@omniroute/open-sse/services/combo.ts";
import type { ComboLike } from "@omniroute/open-sse/services/combo/types.ts";
import { resolveComboConfig } from "@omniroute/open-sse/services/comboConfig.ts";
import type { CompressionExclusions } from "@omniroute/open-sse/services/compression/exclusions.ts";

/** Defer hard overflow preflight only when compression can run for this key. */
export async function resolveComboContextOverflowDeferral(
  logger: { warn?: (...args: unknown[]) => void } | null | undefined,
  apiKeyInfo: { compressionEnabled?: boolean } | null | undefined
): Promise<{ defer: boolean; exclusions: CompressionExclusions | undefined }> {
  try {
    const compression = await resolveCompressionSettings(logger);
    return {
      defer: compression.enabled && apiKeyInfo?.compressionEnabled !== false,
      exclusions: compression.settings?.exclusions,
    };
  } catch {
    return { defer: false, exclusions: undefined };
  }
}

/** Managed leases cannot safely dispatch multi-target or side-effectful combos. */
export function isManagedComboUnsupported(
  combo: ComboLike,
  settings: Record<string, unknown>,
  allCombos: ComboLike[],
  visited = new Set<string>()
): boolean {
  if (visited.has(combo.name)) return false;
  visited.add(combo.name);
  const strategy = combo.strategy ?? "priority";
  const config = resolveComboConfig(combo, settings) as Record<string, unknown>;
  const resolvedTargets = resolveComboTargets(combo, allCombos);
  const pipeline =
    strategy === "pipeline" ||
    (strategy === "auto" && (config.pipeline_enabled === true || combo.name === "auto/smart"));
  const nestedUnsafe = (combo.models as Array<{ kind?: string; comboName?: string }>).some(
    (step) => {
      if (step?.kind !== "combo-ref" || !step.comboName) return false;
      const nested = allCombos.find((candidate) => candidate.name === step.comboName);
      return Boolean(nested && isManagedComboUnsupported(nested, settings, allCombos, visited));
    }
  );
  return (
    strategy === "fusion" ||
    strategy === "context-relay" ||
    (config.chaos as { enabled?: boolean } | undefined)?.enabled === true ||
    (config.shadowRouting as { enabled?: boolean } | undefined)?.enabled === true ||
    (config.zeroLatencyOptimizationsEnabled === true && config.hedging === true) ||
    (resolvedTargets.length > 1 &&
      (pipeline || resolvedTargets.some((target) => Boolean(target.connectionId?.trim())))) ||
    nestedUnsafe
  );
}
