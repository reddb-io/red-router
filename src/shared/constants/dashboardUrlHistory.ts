/**
 * Area URLs that have been served in a release, as `[area URL prefix, the /dashboard page it rewrote to]`.
 * `dashboardUrls.ts` redirects every one of them to the page's CURRENT URL, so a bookmark or a link
 * from an earlier release keeps working after the menu is reorganised.
 *
 * Append-only: when a release changes an area URL, add the previous pair here. A snapshot, not derived
 * from the menu (that is the point: the menu has moved on). It imports nothing so `next.config.mjs`
 * can load it directly (Node's type stripping).
 *
 * Release 1 (URLs follow the menu areas, generated from the menu model of that release):
 */
export const SHIPPED_AREA_URLS: readonly (readonly [string, string])[] = [
  ["/proxy/a2a", "/dashboard/a2a"],
  ["/agents/acp-agents", "/dashboard/acp-agents"],
  ["/observe/activity", "/dashboard/activity"],
  ["/optimize/agent-skills", "/dashboard/agent-skills"],
  ["/home/analytics", "/dashboard/analytics"],
  ["/optimize/analytics/compression", "/dashboard/analytics/compression"],
  ["/observe/api-endpoints", "/dashboard/api-endpoints"],
  ["/proxy/api-manager", "/dashboard/api-manager"],
  ["/observe/audit", "/dashboard/audit"],
  ["/system/batch", "/dashboard/batch"],
  ["/optimize/cache", "/dashboard/cache"],
  ["/system/chaos", "/dashboard/chaos"],
  ["/agents/cli-agents", "/dashboard/cli-agents"],
  ["/agents/cli-code", "/dashboard/cli-code"],
  ["/agents/cloud-agents", "/dashboard/cloud-agents"],
  ["/proxy/combos", "/dashboard/combos"],
  ["/optimize/compression", "/dashboard/compression"],
  ["/agents/conductor", "/dashboard/conductor"],
  ["/optimize/context", "/dashboard/context"],
  ["/observe/conversations", "/dashboard/conversations"],
  ["/observe/costs", "/dashboard/costs"],
  ["/tools/discovery", "/dashboard/discovery"],
  ["/proxy/endpoint", "/dashboard/endpoint"],
  ["/observe/free-provider-rankings", "/dashboard/free-provider-rankings"],
  ["/observe/free-tiers", "/dashboard/free-tiers"],
  ["/observe/health", "/dashboard/health"],
  ["/observe/log-export", "/dashboard/log-export"],
  ["/observe/logs", "/dashboard/logs"],
  ["/proxy/mcp", "/dashboard/mcp"],
  ["/proxy/media-providers", "/dashboard/media-providers"],
  ["/optimize/memory", "/dashboard/memory"],
  ["/proxy/models", "/dashboard/models"],
  ["/agents/orchestration", "/dashboard/orchestration"],
  ["/tools/playground", "/dashboard/playground"],
  ["/agents/plugins", "/dashboard/plugins"],
  ["/home/provider-stats", "/dashboard/provider-stats"],
  ["/proxy/providers", "/dashboard/providers"],
  ["/proxy/quota", "/dashboard/quota"],
  ["/observe/radar", "/dashboard/radar"],
  ["/proxy/relay", "/dashboard/relay"],
  ["/observe/resilience", "/dashboard/resilience"],
  ["/observe/runtime", "/dashboard/runtime"],
  ["/tools/search-tools", "/dashboard/search-tools"],
  ["/system/settings", "/dashboard/settings"],
  ["/home/setup", "/dashboard/setup"],
  ["/optimize/skills", "/dashboard/skills"],
  ["/system/proxy", "/dashboard/system/proxy"],
  ["/agents/agent-bridge", "/dashboard/tools/agent-bridge"],
  ["/tools/traffic-inspector", "/dashboard/tools/traffic-inspector"],
  ["/tools/translator", "/dashboard/translator"],
  ["/observe/usage-sinks", "/dashboard/usage-sinks"],
  ["/observe/webhooks", "/dashboard/webhooks"],
];
