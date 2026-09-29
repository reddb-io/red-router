/**
 * The dashboard menu as the operator sees it: a handful of entries per task, each with the pages
 * that belong to it as route tabs. Every page keeps its URL and its hideable id from
 * `SIDEBAR_SECTIONS` (the page registry the command palette, breadcrumbs and the Settings →
 * Sidebar editor still read); the menu only groups them.
 *
 * Visibility: a tab with an `id` is hidden when that id is in `hiddenSidebarItems`; a tab without
 * one is part of its entry and is shown whenever the entry is. An entry is shown while at least
 * one of its tabs that has an id is visible, and it opens on the first visible tab.
 */
import type { HideableSidebarItemId } from "./sidebarVisibility/types";

export type SidebarNavSectionId =
  "home" | "proxy" | "optimize" | "agents" | "observe" | "build" | "system" | "labs";

export interface SidebarNavTab {
  /** The hideable page id this tab is; absent for pages that were never separate menu items. */
  id?: HideableSidebarItemId;
  href: string;
  label: string;
  /** Opens in a new browser tab instead of the app shell. */
  external?: boolean;
  /** Match the URL exactly (e.g. `/home`). */
  exact?: boolean;
  featureFlagKey?: "RADAR_ENABLED";
}

export interface SidebarNavEntry {
  id: string;
  label: string;
  icon: string;
  /** The entry's own hideable id when it was a menu item by itself (used for the icon accent). */
  accentId?: string;
  tabs: readonly SidebarNavTab[];
}

export interface SidebarNavSection {
  id: SidebarNavSectionId;
  title: string;
  /** Sections without a title render their entries directly (Home). */
  showTitle?: boolean;
  /** Collapsed the first time the operator sees the menu. */
  collapsedByDefault?: boolean;
  entries: readonly SidebarNavEntry[];
}

const tab = (
  id: HideableSidebarItemId | undefined,
  href: string,
  label: string,
  extra: Partial<SidebarNavTab> = {}
): SidebarNavTab => ({ ...(id ? { id } : {}), href, label, ...extra });

export const SIDEBAR_NAV_SECTIONS: readonly SidebarNavSection[] = [
  {
    id: "home",
    title: "Home",
    showTitle: false,
    entries: [
      {
        id: "home",
        label: "Home",
        icon: "home",
        tabs: [tab("home", "/home", "Home", { exact: true })],
      },
      {
        id: "setup",
        label: "Setup",
        icon: "rocket_launch",
        tabs: [tab("setup", "/dashboard/setup", "Setup")],
      },
    ],
  },
  {
    id: "proxy",
    title: "Proxy",
    entries: [
      {
        id: "endpoint-keys",
        label: "Endpoint & Keys",
        icon: "api",
        accentId: "endpoints",
        tabs: [
          tab("endpoints", "/dashboard/endpoint", "Endpoint"),
          tab("api-manager", "/dashboard/api-manager", "API keys"),
          tab(undefined, "/dashboard/api-manager/routing", "Key routing"),
          tab("mcp", "/dashboard/mcp", "MCP"),
          tab("a2a", "/dashboard/a2a", "A2A"),
        ],
      },
      {
        id: "providers",
        label: "Providers",
        icon: "dns",
        tabs: [
          tab("providers", "/dashboard/providers", "Providers"),
          tab("embedded-services", "/dashboard/providers/services", "Local services"),
          tab(undefined, "/dashboard/media-providers", "Media providers"),
          tab(undefined, "/dashboard/relay", "Relay"),
        ],
      },
      {
        id: "model-catalog",
        label: "Models",
        icon: "view_list",
        tabs: [tab("model-catalog", "/dashboard/models", "Models")],
      },
      {
        id: "combos",
        label: "Combos",
        icon: "layers",
        tabs: [
          tab("combos", "/dashboard/combos", "Combos"),
          tab("combos-live", "/dashboard/combos/live", "Live"),
          tab(undefined, "/dashboard/combos/playground", "Playground"),
        ],
      },
    ],
  },
  {
    id: "optimize",
    title: "Optimize",
    entries: [
      {
        id: "token-saver",
        label: "Token saver",
        icon: "compress",
        accentId: "context-rtk",
        tabs: [
          tab("context-settings", "/dashboard/context/settings", "Settings"),
          tab("context-combos", "/dashboard/context/combos", "Engine combos"),
          tab("compression-studio", "/dashboard/compression/studio", "Studio"),
          tab("compression-exclusions", "/dashboard/compression/exclusions", "Exclusions"),
          tab(undefined, "/dashboard/compression/live", "Live"),
          tab("context-caveman", "/dashboard/context/caveman", "Caveman"),
          tab("context-rtk", "/dashboard/context/rtk", "RTK"),
          tab("context-headroom", "/dashboard/context/headroom", "Headroom"),
          tab("context-session-dedup", "/dashboard/context/session-dedup", "Dedup"),
          tab("context-ccr", "/dashboard/context/ccr", "CCR"),
          tab("context-llmlingua", "/dashboard/context/llmlingua", "LLMLingua"),
          tab("context-lite", "/dashboard/context/lite", "Lite"),
          tab("context-aggressive", "/dashboard/context/aggressive", "Aggressive"),
          tab("context-ultra", "/dashboard/context/ultra", "Ultra"),
          tab("context-omniglyph", "/dashboard/context/omniglyph", "OmniGlyph"),
          tab("analytics-compression", "/dashboard/analytics/compression", "Analytics"),
        ],
      },
      {
        id: "cache",
        label: "Cache",
        icon: "cached",
        tabs: [
          tab("cache", "/dashboard/cache", "Cache"),
          tab("media", "/dashboard/cache/media", "Media"),
        ],
      },
      {
        id: "skills",
        label: "Skills",
        icon: "auto_fix_high",
        tabs: [
          tab("skills", "/dashboard/omni-skills", "Skills"),
          tab("agent-skills", "/dashboard/agent-skills", "Catalog"),
          tab(undefined, "/dashboard/skills/styles", "Prompt styles"),
        ],
      },
      {
        id: "memory",
        label: "Memory",
        icon: "psychology",
        tabs: [tab("memory", "/dashboard/memory", "Memory")],
      },
    ],
  },
  {
    id: "agents",
    title: "Agents",
    entries: [
      {
        id: "agents",
        label: "Agents",
        icon: "smart_toy",
        accentId: "cli-agents",
        tabs: [
          tab("cli-code", "/dashboard/cli-code", "CLI code"),
          tab("cli-agents", "/dashboard/cli-agents", "CLI agents"),
          tab("acp-agents", "/dashboard/acp-agents", "ACP"),
          tab("cloud-agents", "/dashboard/cloud-agents", "Cloud"),
        ],
      },
      {
        id: "conductor",
        label: "Conductor",
        icon: "account_tree",
        tabs: [
          tab("conductor", "/dashboard/conductor", "Conductor"),
          tab("orchestration", "/dashboard/orchestration", "Orchestration"),
        ],
      },
      {
        id: "agent-bridge",
        label: "Agent bridge",
        icon: "link",
        tabs: [tab("agent-bridge", "/dashboard/tools/agent-bridge", "Agent bridge")],
      },
      {
        id: "plugins",
        label: "Plugins",
        icon: "extension",
        tabs: [tab("plugins", "/dashboard/plugins", "Plugins")],
      },
    ],
  },
  {
    id: "observe",
    title: "Observe",
    entries: [
      {
        id: "analytics",
        label: "Usage",
        icon: "analytics",
        tabs: [
          tab("analytics", "/dashboard/analytics", "Usage"),
          tab("analytics-combo-health", "/dashboard/analytics/combo-health", "Combo health"),
          tab("analytics-utilization", "/dashboard/analytics/utilization", "Utilization"),
          tab("analytics-search", "/dashboard/analytics/search", "Search"),
          tab("analytics-evals", "/dashboard/analytics/evals", "Evals"),
          tab("provider-stats", "/dashboard/provider-stats", "Provider stats"),
        ],
      },
      {
        id: "costs",
        label: "Costs",
        icon: "account_balance_wallet",
        tabs: [
          tab("costs", "/dashboard/costs", "Overview"),
          tab("costs-pricing", "/dashboard/costs/pricing", "Pricing"),
          tab("costs-budget", "/dashboard/costs/budget", "Budget"),
          tab("costs-quota-share", "/dashboard/costs/quota-share", "Quota sharing"),
          tab("costs-free-tiers", "/dashboard/free-tiers", "Free tiers"),
          tab("free-provider-rankings", "/dashboard/free-provider-rankings", "Free rankings"),
          tab("radar", "/dashboard/radar", "Radar", { featureFlagKey: "RADAR_ENABLED" }),
        ],
      },
      {
        id: "quota",
        label: "Quota",
        icon: "tune",
        tabs: [tab("quota", "/dashboard/quota", "Quota")],
      },
      {
        id: "logs",
        label: "Logs",
        icon: "description",
        tabs: [
          tab("logs", "/dashboard/logs", "Requests"),
          tab("logs-proxy", "/dashboard/logs/proxy", "Proxy"),
          tab("logs-console", "/dashboard/logs/console", "Console"),
          tab("logs-timeline", "/dashboard/logs/timeline", "Timeline"),
          tab("conversations", "/dashboard/conversations", "Conversations"),
          tab("activity", "/dashboard/activity", "Activity"),
        ],
      },
      {
        id: "audit",
        label: "Audit",
        icon: "policy",
        tabs: [
          tab("audit", "/dashboard/audit", "Audit log"),
          tab("audit-mcp", "/dashboard/audit/mcp", "MCP"),
          tab("audit-a2a", "/dashboard/audit/a2a", "A2A"),
        ],
      },
      {
        id: "health",
        label: "Health",
        icon: "health_and_safety",
        tabs: [
          tab("health", "/dashboard/health", "Health"),
          tab("runtime", "/dashboard/runtime", "Runtime"),
          tab("resilience-connections", "/dashboard/resilience/connections", "Connections"),
        ],
      },
    ],
  },
  {
    id: "build",
    title: "Build",
    entries: [
      {
        id: "playground",
        label: "Playground",
        icon: "science",
        tabs: [tab("playground", "/dashboard/playground", "Playground")],
      },
      {
        id: "translator",
        label: "Translator",
        icon: "translate",
        tabs: [tab("translator", "/dashboard/translator", "Translator")],
      },
      {
        id: "search-tools",
        label: "Search tools",
        icon: "manage_search",
        tabs: [tab("search-tools", "/dashboard/search-tools", "Search tools")],
      },
      {
        id: "traffic-inspector",
        label: "Traffic inspector",
        icon: "network_check",
        tabs: [tab("traffic-inspector", "/dashboard/tools/traffic-inspector", "Inspector")],
      },
      {
        id: "discovery",
        label: "Discovery",
        icon: "travel_explore",
        tabs: [tab("discovery", "/dashboard/discovery", "Discovery")],
      },
      {
        id: "integrations",
        label: "Integrations",
        icon: "webhook",
        accentId: "webhooks",
        tabs: [
          tab("webhooks", "/dashboard/webhooks", "Webhooks"),
          tab("log-export", "/dashboard/log-export", "Log export"),
          tab("usage-sinks", "/dashboard/usage-sinks", "Usage sinks"),
          tab("api-endpoints", "/dashboard/api-endpoints", "API endpoints"),
        ],
      },
    ],
  },
  {
    id: "system",
    title: "System",
    entries: [
      {
        id: "settings",
        label: "Settings",
        icon: "settings",
        accentId: "settings-general",
        tabs: [
          tab("settings-general", "/dashboard/settings/general", "Storage"),
          tab("settings-appearance", "/dashboard/settings/appearance", "Appearance"),
          tab("settings-ai", "/dashboard/settings/ai", "AI"),
          tab("settings-modality-bridge", "/dashboard/settings/modality-bridge", "Modality bridge"),
          tab("settings-routing", "/dashboard/settings/routing", "Routing"),
          tab("settings-resilience", "/dashboard/settings/resilience", "Resilience"),
          tab("settings-advanced", "/dashboard/settings/advanced", "Advanced"),
          tab("settings-security", "/dashboard/settings/security", "Security"),
          tab("settings-access-tokens", "/dashboard/settings/access-tokens", "Access tokens"),
          tab("settings-feature-flags", "/dashboard/settings/feature-flags", "Feature flags"),
          tab("settings-cache", "/dashboard/settings/cache", "Cache"),
          tab("settings-sidebar", "/dashboard/settings/sidebar", "Sidebar"),
          tab(undefined, "/dashboard/system/proxy", "Outbound proxies"),
        ],
      },
      {
        id: "docs",
        label: "Docs",
        icon: "menu_book",
        tabs: [tab("docs", "/docs", "Docs", { external: true })],
      },
      {
        id: "issues",
        label: "Issues",
        icon: "bug_report",
        tabs: [
          tab("issues", "https://github.com/reddb-io/red-router/issues", "Issues", {
            external: true,
          }),
        ],
      },
      {
        id: "changelog",
        label: "Changelog",
        icon: "campaign",
        tabs: [tab("changelog", "/dashboard/changelog", "Changelog")],
      },
    ],
  },
  {
    id: "labs",
    title: "Labs",
    collapsedByDefault: true,
    entries: [
      {
        id: "chaos",
        label: "Chaos mode",
        icon: "blender",
        tabs: [tab("chaos-config", "/dashboard/chaos", "Chaos mode")],
      },
      {
        id: "gamification",
        label: "Gamification",
        icon: "emoji_events",
        tabs: [
          tab("leaderboard", "/dashboard/leaderboard", "Leaderboard"),
          tab("profile", "/dashboard/profile", "Profile"),
          tab("tokens", "/dashboard/tokens", "Tokens"),
          tab("gamification-admin", "/dashboard/gamification/admin", "Admin"),
        ],
      },
      {
        id: "batch",
        label: "Batch",
        icon: "view_list",
        tabs: [
          tab("batch", "/dashboard/batch", "Batch jobs"),
          tab("batch-files", "/dashboard/batch/files", "Files"),
        ],
      },
    ],
  },
];

// ─── Resolution ───────────────────────────────────────────────────────────────

export interface ResolvedNavEntry extends SidebarNavEntry {
  /** Where the entry opens: its first visible tab. */
  href: string;
  external: boolean;
  /** The tabs the operator can see (hidden pages and flag-gated pages are gone). */
  tabs: readonly SidebarNavTab[];
}

export interface ResolvedNavSection extends Omit<SidebarNavSection, "entries"> {
  entries: readonly ResolvedNavEntry[];
}

export function isNavTabVisible(
  tabDefinition: SidebarNavTab,
  hidden: ReadonlySet<string>,
  flags: Record<string, boolean>
): boolean {
  if (tabDefinition.id && hidden.has(tabDefinition.id)) return false;
  if (tabDefinition.featureFlagKey && flags[tabDefinition.featureFlagKey] === false) return false;
  return true;
}

/** The entry with only its visible tabs, or null when none of its identified pages is visible. */
export function resolveNavEntry(
  entry: SidebarNavEntry,
  hidden: ReadonlySet<string>,
  flags: Record<string, boolean> = {},
  extraTabs: readonly SidebarNavTab[] = []
): ResolvedNavEntry | null {
  const visible = [...entry.tabs, ...extraTabs].filter((candidate) =>
    isNavTabVisible(candidate, hidden, flags)
  );
  if (!visible.some((candidate) => candidate.id)) return null;
  const first = visible.find((candidate) => candidate.id) ?? visible[0];
  return { ...entry, tabs: visible, href: first.href, external: first.external === true };
}

export function resolveNavSections(
  hidden: ReadonlySet<string>,
  flags: Record<string, boolean> = {},
  /** Extra tabs by entry id (the owner-only Radar admin link). */
  extraTabs: Readonly<Record<string, readonly SidebarNavTab[]>> = {}
): ResolvedNavSection[] {
  return SIDEBAR_NAV_SECTIONS.map((section) => ({
    ...section,
    entries: section.entries
      .map((entry) => resolveNavEntry(entry, hidden, flags, extraTabs[entry.id] ?? []))
      .filter((entry): entry is ResolvedNavEntry => entry !== null),
  })).filter((section) => section.entries.length > 0);
}

/** The entry and tab a URL belongs to: the longest matching tab href wins. */
export function findNavMatch(
  pathname: string | null | undefined,
  sections: readonly ResolvedNavSection[]
): { entry: ResolvedNavEntry; tab: SidebarNavTab } | null {
  if (!pathname) return null;
  let best: { entry: ResolvedNavEntry; tab: SidebarNavTab } | null = null;
  for (const section of sections) {
    for (const entry of section.entries) {
      for (const candidate of entry.tabs) {
        if (candidate.external) continue;
        const matches = candidate.exact
          ? pathname === candidate.href
          : pathname === candidate.href || pathname.startsWith(`${candidate.href}/`);
        if (matches && (!best || candidate.href.length > best.tab.href.length)) {
          best = { entry, tab: candidate };
        }
      }
    }
  }
  return best;
}

/** Every page the menu can reach, for the route-coverage test and the search. */
export function allNavTabs(): SidebarNavTab[] {
  return SIDEBAR_NAV_SECTIONS.flatMap((section) =>
    section.entries.flatMap((entry) => [...entry.tabs])
  );
}
