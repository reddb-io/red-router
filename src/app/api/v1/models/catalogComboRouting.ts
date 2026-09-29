import { normalizeRoutingStrategy } from "@/shared/constants/routingStrategies";

/**
 * How RedCode learns what a combo does. RedRouter v0.33.0 advertised `strategy` (fallback,
 * round-robin, fusion, smart, auto) and the ordered `members` on every combo entry; RedCode
 * only sends its steering hints to a combo whose strategy it recognises. This build's own
 * strategy names differ, so `strategy` carries the v0.33.0 name and `routing_strategy` keeps
 * the raw one.
 */
export function comboStrategyForClients(raw: unknown): { strategy: string; routing_strategy: string } {
  const routing = String(normalizeRoutingStrategy(raw));
  return { strategy: routing === "priority" ? "fallback" : routing, routing_strategy: routing };
}

/** The provider/model ids a combo can route to, in order and de-duplicated. */
export function comboMemberIds(
  targets: readonly { providerId: string; modelId: string }[],
  prefixFor: (providerId: string) => string
): string[] {
  const ids: string[] = [];
  for (const target of targets) {
    const id = `${prefixFor(target.providerId)}/${target.modelId}`;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}
