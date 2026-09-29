/**
 * The dashboard menu as the operator sees it, in three levels: an AREA on the side rail, the
 * ENTRIES of that area in the side panel, and the PAGES of an entry as tabs above the page.
 * Every page keeps its URL and its hideable id from `SIDEBAR_SECTIONS` (the page registry the
 * command palette, breadcrumbs and Settings → Sidebar still read); the menu only groups them.
 *
 * Visibility: a tab with an `id` is hidden when that id is in `hiddenSidebarItems`; a tab without
 * one is part of its entry and is shown whenever the entry is. An entry is shown while at least
 * one of its tabs that has an id is visible, and it opens on the first visible tab. Pages listed
 * as a tab's `children` are reachable detail pages (they light up their tab) that are not tabs.
 *
 * Icons are lucide glyph names (resolved by `navIcon`), drawn in the design system's neutral ink.
 */
import type { HideableSidebarItemId } from "./sidebarVisibility/types";

export type SidebarNavSectionId =
  "home" | "proxy" | "optimize" | "agents" | "observe" | "tools" | "system";

export interface SidebarNavChild {
  id?: HideableSidebarItemId;
  href: string;
}

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
  /** Rarely used: moved into the "More" menu when the entry has many tabs. */
  secondary?: boolean;
  /** Detail pages of this tab: they keep it selected but are not tabs themselves. */
  children?: readonly SidebarNavChild[];
}

export interface SidebarNavEntry {
  id: string;
  label: string;
  /** A lucide glyph name. */
  icon: string;
  /** Entries with the same group label are listed together under it in the panel. */
  group?: string;
  tabs: readonly SidebarNavTab[];
}

export interface SidebarNavSection {
  id: SidebarNavSectionId;
  /** The area's name: the rail button's label and the panel's heading. */
  title: string;
  /** A lucide glyph name for the rail. */
  icon: string;
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
    icon: "House",
    entries: [
      {
        id: "analytics",
        label: "Usage",
        icon: "ChartColumn",
        tabs: [
          tab("analytics", "/dashboard/analytics", "Usage"),
          tab("home", "/home", "Topology", { exact: true }),
          tab("analytics-combo-health", "/dashboard/analytics/combo-health", "Combo health"),
          tab("analytics-utilization", "/dashboard/analytics/utilization", "Utilization"),
          tab("analytics-search", "/dashboard/analytics/search", "Search", { secondary: true }),
          tab("analytics-evals", "/dashboard/analytics/evals", "Evals", { secondary: true }),
          tab(undefined, "/dashboard/analytics/cache-health", "Cache health", { secondary: true }),
          tab(undefined, "/dashboard/analytics/route-trace", "Route trace", { secondary: true }),
          tab("provider-stats", "/dashboard/provider-stats", "Provider stats"),
        ],
      },
      {
        id: "setup",
        label: "Setup",
        icon: "Rocket",
        tabs: [tab("setup", "/dashboard/setup", "Setup")],
      },
    ],
  },
  {
    id: "proxy",
    title: "Proxy",
    icon: "Waypoints",
    entries: [
      {
        id: "endpoint-keys",
        label: "Endpoint & Keys",
        icon: "Plug",
        tabs: [
          tab("endpoints", "/dashboard/endpoint", "Endpoint", {
            // MCP and A2A are tabs inside the Endpoint page itself; their own routes keep it selected.
            children: [
              { id: "mcp", href: "/dashboard/mcp" },
              { id: "a2a", href: "/dashboard/a2a" },
            ],
          }),
          tab("api-manager", "/dashboard/api-manager", "API keys"),
          tab(undefined, "/dashboard/api-manager/routing", "Key routing"),
        ],
      },
      {
        id: "providers",
        label: "Providers",
        icon: "Server",
        tabs: [
          tab("providers", "/dashboard/providers", "Providers"),
          tab("quota", "/dashboard/quota", "Quota"),
          tab("embedded-services", "/dashboard/providers/services", "Local services"),
          tab(undefined, "/dashboard/media-providers", "Media providers"),
          tab(undefined, "/dashboard/relay", "Relay"),
        ],
      },
      {
        id: "model-catalog",
        label: "Models",
        icon: "Boxes",
        tabs: [tab("model-catalog", "/dashboard/models", "Models")],
      },
      {
        id: "combos",
        label: "Combos",
        icon: "Layers",
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
    icon: "Gauge",
    entries: [
      {
        id: "token-saver",
        label: "Token saver",
        icon: "Minimize2",
        tabs: [
          tab("context-settings", "/dashboard/context/settings", "Overview"),
          tab(undefined, "/dashboard/context/engines", "Engines", {
            children: [
              { id: "context-caveman", href: "/dashboard/context/caveman" },
              { id: "context-rtk", href: "/dashboard/context/rtk" },
              { id: "context-headroom", href: "/dashboard/context/headroom" },
              { id: "context-session-dedup", href: "/dashboard/context/session-dedup" },
              { id: "context-ccr", href: "/dashboard/context/ccr" },
              { id: "context-llmlingua", href: "/dashboard/context/llmlingua" },
              { id: "context-lite", href: "/dashboard/context/lite" },
              { id: "context-aggressive", href: "/dashboard/context/aggressive" },
              { id: "context-ultra", href: "/dashboard/context/ultra" },
              { id: "context-omniglyph", href: "/dashboard/context/omniglyph" },
            ],
          }),
          tab("context-combos", "/dashboard/context/combos", "Combos"),
          tab("compression-studio", "/dashboard/compression/studio", "Studio"),
          tab("compression-exclusions", "/dashboard/compression/exclusions", "Exclusions"),
          tab(undefined, "/dashboard/compression/live", "Live"),
          tab("analytics-compression", "/dashboard/analytics/compression", "Analytics"),
        ],
      },
      {
        id: "cache",
        label: "Cache",
        icon: "Database",
        tabs: [
          tab("cache", "/dashboard/cache", "Cache"),
          tab("media", "/dashboard/cache/media", "Media"),
        ],
      },
      {
        id: "skills",
        label: "Skills",
        icon: "Sparkles",
        tabs: [
          tab("skills", "/dashboard/skills", "Skills"),
          tab("agent-skills", "/dashboard/agent-skills", "Catalog"),
          tab(undefined, "/dashboard/skills/styles", "Prompt styles"),
        ],
      },
      {
        id: "memory",
        label: "Memory",
        icon: "Brain",
        tabs: [tab("memory", "/dashboard/memory", "Memory")],
      },
    ],
  },
  {
    id: "agents",
    title: "Agents",
    icon: "Bot",
    entries: [
      {
        id: "agents",
        label: "Agents",
        icon: "Terminal",
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
        icon: "Workflow",
        tabs: [
          tab("conductor", "/dashboard/conductor", "Conductor"),
          tab("orchestration", "/dashboard/orchestration", "Orchestration"),
        ],
      },
      {
        id: "agent-bridge",
        label: "Agent bridge",
        icon: "Cable",
        tabs: [tab("agent-bridge", "/dashboard/tools/agent-bridge", "Agent bridge")],
      },
      {
        id: "plugins",
        label: "Plugins",
        icon: "Puzzle",
        tabs: [tab("plugins", "/dashboard/plugins", "Plugins")],
      },
    ],
  },
  {
    id: "observe",
    title: "Observe",
    icon: "Activity",
    entries: [
      {
        id: "costs",
        label: "Costs",
        icon: "Wallet",
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
        id: "logs",
        label: "Logs",
        icon: "ScrollText",
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
        icon: "ShieldCheck",
        tabs: [
          tab("audit", "/dashboard/audit", "Audit log"),
          tab("audit-mcp", "/dashboard/audit/mcp", "MCP"),
          tab("audit-a2a", "/dashboard/audit/a2a", "A2A"),
        ],
      },
      {
        id: "health",
        label: "Health",
        icon: "HeartPulse",
        tabs: [
          tab("health", "/dashboard/health", "Health"),
          tab("runtime", "/dashboard/runtime", "Runtime"),
          tab("resilience-connections", "/dashboard/resilience/connections", "Connections"),
        ],
      },
      {
        id: "integrations",
        label: "Integrations",
        icon: "Webhook",
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
    id: "tools",
    title: "Tools",
    icon: "Wrench",
    entries: [
      {
        id: "playground",
        label: "Playground",
        icon: "FlaskConical",
        tabs: [tab("playground", "/dashboard/playground", "Playground")],
      },
      {
        id: "translator",
        label: "Translator",
        icon: "Languages",
        tabs: [tab("translator", "/dashboard/translator", "Translator")],
      },
      {
        id: "search-tools",
        label: "Search tools",
        icon: "ScanSearch",
        tabs: [tab("search-tools", "/dashboard/search-tools", "Search tools")],
      },
      {
        id: "traffic-inspector",
        label: "Traffic inspector",
        icon: "Radar",
        tabs: [tab("traffic-inspector", "/dashboard/tools/traffic-inspector", "Inspector")],
      },
      {
        id: "discovery",
        label: "Discovery",
        icon: "Compass",
        tabs: [tab("discovery", "/dashboard/discovery", "Discovery")],
      },
    ],
  },
  {
    id: "system",
    title: "System",
    icon: "Settings",
    entries: [
      {
        id: "settings",
        label: "Settings",
        icon: "SlidersHorizontal",
        tabs: [
          tab("settings-general", "/dashboard/settings/general", "Storage"),
          tab("settings-appearance", "/dashboard/settings/appearance", "Appearance"),
          tab("settings-ai", "/dashboard/settings/ai", "AI"),
          tab("settings-routing", "/dashboard/settings/routing", "Routing"),
          tab("settings-resilience", "/dashboard/settings/resilience", "Resilience"),
          tab("settings-security", "/dashboard/settings/security", "Security"),
          tab("settings-advanced", "/dashboard/settings/advanced", "Advanced"),
          tab(
            "settings-modality-bridge",
            "/dashboard/settings/modality-bridge",
            "Modality bridge",
            {
              secondary: true,
            }
          ),
          tab("settings-access-tokens", "/dashboard/settings/access-tokens", "Access tokens", {
            secondary: true,
          }),
          tab("settings-feature-flags", "/dashboard/settings/feature-flags", "Feature flags", {
            secondary: true,
          }),
          tab("settings-cache", "/dashboard/settings/cache", "Cache", { secondary: true }),
          tab("settings-sidebar", "/dashboard/settings/sidebar", "Sidebar", { secondary: true }),
          tab(undefined, "/dashboard/system/proxy", "Outbound proxies", { secondary: true }),
        ],
      },
      {
        id: "docs",
        label: "Docs",
        icon: "BookOpen",
        tabs: [tab("docs", "/docs", "Docs", { external: true })],
      },
      {
        id: "issues",
        label: "Issues",
        icon: "Bug",
        tabs: [
          tab("issues", "https://github.com/reddb-io/red-router/issues", "Issues", {
            external: true,
          }),
        ],
      },
      {
        id: "chaos",
        label: "Chaos mode",
        icon: "Zap",
        group: "Labs",
        tabs: [tab("chaos-config", "/dashboard/chaos", "Chaos mode")],
      },
      {
        id: "batch",
        label: "Batch",
        icon: "ListChecks",
        group: "Labs",
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

const matchesHref = (pathname: string, href: string, exact?: boolean): boolean =>
  exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);

/** The area, entry and tab a URL belongs to: the longest matching page href wins. */
export function findNavMatch(
  pathname: string | null | undefined,
  sections: readonly ResolvedNavSection[]
): { section: ResolvedNavSection; entry: ResolvedNavEntry; tab: SidebarNavTab } | null {
  if (!pathname) return null;
  let best: {
    section: ResolvedNavSection;
    entry: ResolvedNavEntry;
    tab: SidebarNavTab;
    length: number;
  } | null = null;
  for (const section of sections) {
    for (const entry of section.entries) {
      for (const candidate of entry.tabs) {
        if (candidate.external) continue;
        const hrefs = [
          { href: candidate.href, exact: candidate.exact },
          ...(candidate.children ?? []).map((child) => ({ href: child.href, exact: false })),
        ];
        for (const { href, exact } of hrefs) {
          if (matchesHref(pathname, href, exact) && (!best || href.length > best.length)) {
            best = { section, entry, tab: candidate, length: href.length };
          }
        }
      }
    }
  }
  return best ? { section: best.section, entry: best.entry, tab: best.tab } : null;
}

/** Every page the menu can reach (tabs and their detail pages), for the coverage test. */
export function allNavTabs(): SidebarNavTab[] {
  return SIDEBAR_NAV_SECTIONS.flatMap((section) =>
    section.entries.flatMap((entry) =>
      entry.tabs.flatMap((candidate) => [
        candidate,
        ...(candidate.children ?? []).map((child) => ({
          ...(child.id ? { id: child.id } : {}),
          href: child.href,
          label: candidate.label,
        })),
      ])
    )
  );
}

/** The tabs of a resolved entry split for the tab bar: the primary ones and the "More" menu. */
export function splitNavTabs(
  tabs: readonly SidebarNavTab[],
  limit = 8
): { primary: SidebarNavTab[]; more: SidebarNavTab[] } {
  if (tabs.length <= limit) return { primary: [...tabs], more: [] };
  const primary = tabs.filter((candidate) => !candidate.secondary);
  const more = tabs.filter((candidate) => candidate.secondary);
  return { primary, more };
}
