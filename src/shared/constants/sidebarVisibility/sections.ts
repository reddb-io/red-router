import type {
  SidebarItemDefinition,
  SidebarItemGroup,
  SidebarSectionChild,
  SidebarSectionDefinition,
} from "./types";

// ─── Item arrays ────────────────────────────────────────────────────────────

const HOME_ITEMS: readonly SidebarItemDefinition[] = [
  {
    id: "home",
    href: "/home",
    i18nKey: "home",
    subtitleKey: "homeSubtitle",
    icon: "home",
    exact: true,
  },
  {
    id: "setup",
    href: "/home/setup",
    i18nKey: "setup",
    labelFallback: "Setup",
    subtitleKey: "setupSubtitle",
    subtitleFallback: "Connect, key, validate, organize",
    icon: "rocket_launch",
  },
];

const OMNI_PROXY_ITEMS: readonly SidebarItemDefinition[] = [
  {
    id: "endpoints",
    href: "/proxy/endpoint",
    i18nKey: "endpoints",
    subtitleKey: "endpointsSubtitle",
    icon: "api",
  },
  {
    id: "api-manager",
    href: "/proxy/keys",
    i18nKey: "apiManager",
    subtitleKey: "apiManagerSubtitle",
    icon: "vpn_key",
  },
  {
    id: "providers",
    href: "/proxy/providers",
    i18nKey: "providers",
    subtitleKey: "providersSubtitle",
    icon: "dns",
  },
  {
    id: "model-catalog",
    href: "/proxy/models",
    i18nKey: "modelCatalog",
    labelFallback: "Models",
    subtitleKey: "modelCatalogSubtitle",
    subtitleFallback: "Model catalog for all connected providers.",
    icon: "view_list",
  },
  {
    id: "embedded-services",
    href: "/proxy/providers/services",
    i18nKey: "embeddedServices",
    subtitleKey: "embeddedServicesSubtitle",
    icon: "deployed_code",
  },
  {
    id: "combos",
    href: "/proxy/combos",
    i18nKey: "combos",
    subtitleKey: "combosSubtitle",
    icon: "layers",
  },
  {
    id: "combos-live",
    href: "/proxy/combos/live",
    i18nKey: "combosLive",
    labelFallback: "Combo Studio",
    subtitleKey: "combosLiveSubtitle",
    subtitleFallback: "Live routing cascade",
    icon: "account_tree",
  },
  {
    id: "quota",
    href: "/observe/costs/quota",
    i18nKey: "providerQuota",
    subtitleKey: "providerQuotaSubtitle",
    icon: "tune",
  },
  {
    id: "costs-quota-share",
    href: "/observe/costs/quota-share",
    i18nKey: "costsQuotaShare",
    subtitleKey: "costsQuotaShareSubtitle",
    icon: "pie_chart",
  },
];

export const COMPRESSION_CONTEXT_GROUP: SidebarItemGroup = {
  type: "group",
  id: "compression-context",
  titleKey: "compressionContextGroup",
  titleFallback: "Compression Context",
  // Order: Settings (the unified panel) → Combos → per-engine pages → Studio (analytics).
  items: [
    {
      id: "context-settings",
      href: "/optimize/token-saver",
      i18nKey: "contextSettings",
      labelFallback: "Compression Settings",
      subtitleKey: "contextSettingsSubtitle",
      subtitleFallback: "Global defaults",
      icon: "settings",
    },
    {
      id: "context-combos",
      href: "/optimize/token-saver/combos",
      i18nKey: "contextCombos",
      subtitleKey: "contextCombosSubtitle",
      icon: "hub",
    },
    {
      id: "context-caveman",
      href: "/optimize/token-saver/engines/caveman",
      i18nKey: "contextCaveman",
      subtitleKey: "contextCavemanSubtitle",
      icon: "compress",
    },
    {
      id: "context-rtk",
      href: "/optimize/token-saver/engines/rtk",
      i18nKey: "contextRtk",
      subtitleKey: "contextRtkSubtitle",
      icon: "filter_alt",
    },
    {
      id: "context-headroom",
      href: "/optimize/token-saver/engines/headroom",
      i18nKey: "contextHeadroom",
      labelFallback: "Headroom",
      subtitleKey: "contextHeadroomSubtitle",
      subtitleFallback: "Tabular compaction",
      icon: "table_rows",
    },
    {
      id: "context-session-dedup",
      href: "/optimize/token-saver/engines/session-dedup",
      i18nKey: "contextSessionDedup",
      labelFallback: "Session Dedup",
      subtitleKey: "contextSessionDedupSubtitle",
      subtitleFallback: "Cross-turn dedup",
      icon: "content_copy",
    },
    {
      id: "context-ccr",
      href: "/optimize/token-saver/engines/ccr",
      i18nKey: "contextCcr",
      labelFallback: "CCR",
      subtitleKey: "contextCcrSubtitle",
      subtitleFallback: "Retrieve markers",
      icon: "archive",
    },
    {
      id: "context-llmlingua",
      href: "/optimize/token-saver/engines/llmlingua",
      i18nKey: "contextLlmlingua",
      labelFallback: "LLMLingua",
      subtitleKey: "contextLlmlinguaSubtitle",
      subtitleFallback: "Semantic pruning",
      icon: "psychology",
    },
    {
      id: "context-lite",
      href: "/optimize/token-saver/engines/lite",
      i18nKey: "contextLite",
      labelFallback: "Lite",
      subtitleKey: "contextLiteSubtitle",
      subtitleFallback: "Fast whitespace cleanup",
      icon: "compress",
    },
    {
      id: "context-aggressive",
      href: "/optimize/token-saver/engines/aggressive",
      i18nKey: "contextAggressive",
      labelFallback: "Aggressive",
      subtitleKey: "contextAggressiveSubtitle",
      subtitleFallback: "Summary + aging",
      icon: "speed",
    },
    {
      id: "context-ultra",
      href: "/optimize/token-saver/engines/ultra",
      i18nKey: "contextUltra",
      labelFallback: "Ultra",
      subtitleKey: "contextUltraSubtitle",
      subtitleFallback: "Heuristic pruning",
      icon: "bolt",
    },
    {
      id: "context-omniglyph",
      href: "/optimize/token-saver/engines/omniglyph",
      i18nKey: "contextOmniglyph",
      labelFallback: "Glyph",
      subtitleKey: "contextOmniglyphSubtitle",
      subtitleFallback: "Context-as-image",
      icon: "grain",
    },
    {
      id: "compression-studio",
      href: "/optimize/token-saver/studio",
      i18nKey: "compressionStudio",
      labelFallback: "Compression Studio",
      subtitleKey: "compressionStudioSubtitle",
      subtitleFallback: "Live engine cascade",
      icon: "monitoring",
    },
    {
      id: "compression-exclusions",
      href: "/optimize/token-saver/exclusions",
      i18nKey: "compressionExclusions",
      labelFallback: "Exclusions",
      subtitleKey: "compressionExclusionsSubtitle",
      subtitleFallback: "Per-model/endpoint bypass",
      icon: "block",
    },
  ],
};

const TOOLS_GROUP: SidebarItemGroup = {
  type: "group",
  id: "tools",
  titleKey: "toolsGroup",
  titleFallback: "Tools",
  items: [
    {
      id: "cli-code",
      href: "/agents/cli-code",
      i18nKey: "cliCode",
      subtitleKey: "cliCodeSubtitle",
      icon: "terminal",
    },
    {
      id: "cli-agents",
      href: "/agents/cli-agents",
      i18nKey: "cliAgents",
      subtitleKey: "cliAgentsSubtitle",
      icon: "smart_toy",
    },
    {
      id: "acp-agents",
      href: "/agents/acp-agents",
      i18nKey: "acpAgents",
      subtitleKey: "acpAgentsSubtitle",
      icon: "device_hub",
    },
    {
      id: "cloud-agents",
      href: "/agents/cloud-agents",
      i18nKey: "cloudAgents",
      subtitleKey: "cloudAgentsSubtitle",
      icon: "cloud",
    },
    {
      id: "conductor",
      href: "/agents/conductor",
      i18nKey: "conductor",
      subtitleKey: "conductorSubtitle",
      icon: "account_tree",
      labelFallback: "Conductor",
      subtitleFallback: "CLI-agent fleet",
    },
    {
      id: "orchestration",
      href: "/agents/orchestration",
      i18nKey: "orchestration",
      subtitleKey: "orchestrationSubtitle",
      icon: "account_tree",
    },
    {
      id: "agent-bridge",
      href: "/agents/bridge",
      i18nKey: "agentBridge",
      subtitleKey: "agentBridgeSubtitle",
      icon: "link",
    },
    {
      id: "traffic-inspector",
      href: "/tools/inspector",
      i18nKey: "trafficInspector",
      subtitleKey: "trafficInspectorSubtitle",
      icon: "network_check",
    },
    {
      id: "discovery",
      href: "/tools/discovery",
      i18nKey: "discovery",
      subtitleKey: "discoverySubtitle",
      icon: "travel_explore",
    },
  ],
};

const INTEGRATIONS_GROUP: SidebarItemGroup = {
  type: "group",
  id: "integrations",
  titleKey: "integrationsGroup",
  titleFallback: "Integrations",
  items: [
    {
      id: "api-endpoints",
      href: "/observe/api-endpoints",
      i18nKey: "apiEndpoints",
      subtitleKey: "apiEndpointsSubtitle",
      icon: "api",
    },
    {
      id: "webhooks",
      href: "/observe/webhooks",
      i18nKey: "webhooks",
      subtitleKey: "webhooksSubtitle",
      icon: "webhook",
    },
    {
      id: "log-export",
      href: "/observe/log-export",
      i18nKey: "logExport",
      subtitleKey: "logExportSubtitle",
      icon: "cloud_upload",
      labelFallback: "Log export",
      subtitleFallback: "Ship call logs out",
    },
    {
      id: "usage-sinks",
      href: "/observe/usage-sinks",
      i18nKey: "usageSinks",
      subtitleKey: "usageSinksSubtitle",
      icon: "payments",
      labelFallback: "Usage Sinks",
      subtitleFallback: "Send usage to billing",
    },
  ],
};

const PROXY_ITEM: SidebarItemDefinition = {
  id: "proxy",
  href: "/system/outbound-proxies",
  i18nKey: "proxy",
  subtitleKey: "proxySubtitle",
  icon: "dns",
};

const ANALYTICS_ITEMS: readonly SidebarItemDefinition[] = [
  {
    id: "analytics",
    href: "/home/analytics",
    i18nKey: "usage",
    subtitleKey: "usageSubtitle",
    icon: "analytics",
  },
  {
    id: "analytics-combo-health",
    href: "/home/analytics/combo-health",
    i18nKey: "analyticsComboHealth",
    subtitleKey: "analyticsComboHealthSubtitle",
    icon: "monitor_heart",
  },
  {
    id: "analytics-utilization",
    href: "/home/analytics/utilization",
    i18nKey: "analyticsUtilization",
    subtitleKey: "analyticsUtilizationSubtitle",
    icon: "bar_chart",
  },
  {
    id: "cache",
    href: "/optimize/cache",
    i18nKey: "cache",
    subtitleKey: "cacheSubtitle",
    icon: "cached",
  },
  {
    id: "analytics-compression",
    href: "/optimize/token-saver/analytics",
    i18nKey: "analyticsCompression",
    subtitleKey: "analyticsCompressionSubtitle",
    icon: "compress",
  },
  {
    id: "analytics-search",
    href: "/home/analytics/search",
    i18nKey: "analyticsSearch",
    subtitleKey: "analyticsSearchSubtitle",
    icon: "manage_search",
  },
  {
    id: "analytics-evals",
    href: "/home/analytics/evals",
    i18nKey: "analyticsEvals",
    subtitleKey: "analyticsEvalsSubtitle",
    icon: "labs",
  },
  {
    id: "provider-stats",
    href: "/home/provider-stats",
    i18nKey: "providerStats",
    subtitleKey: "providerStatsSubtitle",
    icon: "speed",
  },
];

const MONITORING_ITEMS: readonly SidebarItemDefinition[] = [
  {
    id: "activity",
    href: "/observe/logs/activity",
    i18nKey: "activity",
    subtitleKey: "activitySubtitle",
    icon: "timeline",
  },
];

const LOGS_GROUP: SidebarItemGroup = {
  type: "group",
  id: "logs",
  titleKey: "logsGroup",
  titleFallback: "Logs",
  items: [
    {
      id: "logs",
      href: "/observe/logs",
      i18nKey: "logs",
      subtitleKey: "logsSubtitle",
      icon: "description",
    },
    {
      id: "logs-proxy",
      href: "/observe/logs/proxy",
      i18nKey: "logsProxy",
      subtitleKey: "logsProxySubtitle",
      icon: "lan",
    },
    {
      id: "logs-console",
      href: "/observe/logs/console",
      i18nKey: "consoleLogs",
      subtitleKey: "consoleLogsSubtitle",
      icon: "terminal",
    },
    {
      id: "logs-timeline",
      href: "/observe/logs/timeline",
      i18nKey: "logsTimeline",
      subtitleKey: "logsTimelineSubtitle",
      icon: "view_timeline",
    },
    {
      id: "conversations",
      href: "/observe/logs/conversations",
      i18nKey: "conversations",
      subtitleKey: "conversationsSubtitle",
      icon: "forum",
    },
  ],
};

const SYSTEM_GROUP: SidebarItemGroup = {
  type: "group",
  id: "system",
  titleKey: "systemGroup",
  titleFallback: "System",
  items: [
    {
      id: "health",
      href: "/observe/health",
      i18nKey: "health",
      subtitleKey: "healthSubtitle",
      icon: "health_and_safety",
    },
    {
      id: "runtime",
      href: "/observe/health/runtime",
      i18nKey: "runtime",
      subtitleKey: "runtimeSubtitle",
      icon: "bolt",
    },
    {
      id: "resilience-connections",
      href: "/observe/health/connections",
      i18nKey: "resilienceConnections",
      subtitleKey: "resilienceConnectionsSubtitle",
      icon: "shield",
    },
  ],
};

const COSTS_ITEMS: readonly SidebarItemDefinition[] = [
  {
    id: "costs",
    href: "/observe/costs",
    i18nKey: "costsOverview",
    subtitleKey: "costsOverviewSubtitle",
    icon: "account_balance_wallet",
  },
  {
    id: "costs-pricing",
    href: "/observe/costs/pricing",
    i18nKey: "costsPricing",
    subtitleKey: "costsPricingSubtitle",
    icon: "price_change",
  },
  {
    id: "costs-budget",
    href: "/observe/costs/budget",
    i18nKey: "costsBudget",
    subtitleKey: "costsBudgetSubtitle",
    icon: "savings",
  },
  {
    id: "costs-free-tiers",
    href: "/proxy/providers/free-tiers",
    i18nKey: "costsFreeTiers",
    subtitleKey: "costsFreeTiersSubtitle",
    icon: "request_quote",
  },
  {
    id: "free-provider-rankings",
    href: "/proxy/providers/rankings",
    i18nKey: "freeProviderRankings",
    subtitleKey: "freeProviderRankingsSubtitle",
    icon: "leaderboard",
  },
  {
    id: "radar",
    href: "/proxy/providers/radar",
    i18nKey: "radar",
    subtitleKey: "radarSubtitle",
    icon: "radar",
    featureFlagKey: "RADAR_ENABLED",
  },
];

const AUDIT_GROUP: SidebarItemGroup = {
  type: "group",
  id: "audit",
  titleKey: "auditGroup",
  titleFallback: "Audit",
  items: [
    {
      id: "audit",
      href: "/observe/audit",
      i18nKey: "auditLog",
      subtitleKey: "auditLogSubtitle",
      icon: "policy",
    },
    {
      id: "audit-mcp",
      href: "/observe/audit/mcp",
      i18nKey: "auditMcp",
      subtitleKey: "auditMcpSubtitle",
      icon: "security",
    },
    {
      id: "audit-a2a",
      href: "/observe/audit/a2a",
      i18nKey: "auditA2a",
      subtitleKey: "auditA2aSubtitle",
      icon: "device_hub",
    },
  ],
};

const DEVTOOLS_ITEMS: readonly SidebarItemDefinition[] = [
  {
    id: "translator",
    href: "/tools/translator",
    i18nKey: "translator",
    subtitleKey: "translatorSubtitle",
    icon: "translate",
  },
  {
    id: "playground",
    href: "/tools/playground",
    i18nKey: "playground",
    subtitleKey: "playgroundSubtitle",
    icon: "science",
  },
  {
    id: "search-tools",
    href: "/tools/search-tools",
    i18nKey: "searchTools",
    subtitleKey: "searchToolsSubtitle",
    icon: "manage_search",
  },
];

const MCP_ITEM: SidebarItemDefinition = {
  id: "mcp",
  href: "/proxy/mcp",
  i18nKey: "mcp",
  subtitleKey: "mcpSubtitle",
  icon: "hub",
};

const AGENTIC_FEATURES_ITEMS: readonly SidebarSectionChild[] = [
  {
    id: "memory",
    href: "/optimize/memory",
    i18nKey: "memory",
    subtitleKey: "memorySubtitle",
    icon: "psychology",
  },
  {
    id: "agent-skills",
    href: "/optimize/agent-skills",
    i18nKey: "agentSkills",
    subtitleKey: "agentSkillsSubtitle",
    icon: "share",
  },
  {
    id: "chaos-config",
    href: "/system/chaos",
    i18nKey: "chaosConfig",
    labelFallback: "Chaos Mode",
    subtitleKey: "chaosConfigSubtitle",
    subtitleFallback: "Multi-model parallel execution",
    icon: "blender",
  },
  {
    id: "skills",
    href: "/optimize/skills",
    i18nKey: "omniSkills",
    subtitleKey: "omniSkillsSubtitle",
    icon: "auto_fix_high",
  },
  MCP_ITEM,
  {
    id: "a2a",
    href: "/proxy/a2a",
    i18nKey: "a2a",
    subtitleKey: "a2aSubtitle",
    icon: "device_hub",
  },
  {
    id: "plugins",
    href: "/agents/plugins",
    i18nKey: "plugins",
    subtitleKey: "pluginsSubtitle",
    icon: "extension",
  },
];

const OTHER_FEATURES_ITEMS: readonly SidebarItemDefinition[] = [
  {
    id: "media",
    href: "/optimize/cache/media",
    i18nKey: "media",
    subtitleKey: "mediaSubtitle",
    icon: "perm_media",
  },
];

const BATCH_GROUP: SidebarItemGroup = {
  type: "group",
  id: "batch",
  titleKey: "batchGroup",
  titleFallback: "Batch",
  items: [
    {
      id: "batch",
      href: "/system/batch",
      i18nKey: "batch",
      subtitleKey: "batchSubtitle",
      icon: "view_list",
    },
    {
      id: "batch-files",
      href: "/system/batch/files",
      i18nKey: "batchFiles",
      subtitleKey: "batchFilesSubtitle",
      icon: "folder",
    },
  ],
};

const CONFIGURATION_ITEMS: readonly SidebarItemDefinition[] = [
  {
    id: "settings-general",
    href: "/system/settings/storage",
    i18nKey: "settingsGeneral",
    subtitleKey: "settingsGeneralSubtitle",
    icon: "tune",
  },
  {
    id: "settings-appearance",
    href: "/system/settings/appearance",
    i18nKey: "settingsAppearance",
    subtitleKey: "settingsAppearanceSubtitle",
    icon: "palette",
  },
  {
    id: "settings-ai",
    href: "/system/settings/ai",
    i18nKey: "settingsAi",
    subtitleKey: "settingsAiSubtitle",
    icon: "auto_awesome",
  },
  {
    id: "settings-modality-bridge",
    href: "/system/settings/modality-bridge",
    i18nKey: "settingsModalityBridge",
    subtitleKey: "settingsModalityBridgeSubtitle",
    icon: "image_search",
  },
  {
    id: "settings-routing",
    href: "/system/settings/routing",
    i18nKey: "globalRouting",
    subtitleKey: "globalRoutingSubtitle",
    icon: "route",
  },
  {
    id: "settings-resilience",
    href: "/system/settings/resilience",
    i18nKey: "settingsResilience",
    subtitleKey: "settingsResilienceSubtitle",
    icon: "health_and_safety",
  },
  {
    id: "settings-advanced",
    href: "/system/settings/advanced",
    i18nKey: "settingsAdvanced",
    subtitleKey: "settingsAdvancedSubtitle",
    icon: "engineering",
  },
  {
    id: "settings-security",
    href: "/system/settings/security",
    i18nKey: "settingsSecurity",
    subtitleKey: "settingsSecuritySubtitle",
    icon: "shield",
  },
  {
    id: "settings-access-tokens",
    href: "/system/settings/access-tokens",
    i18nKey: "settingsAccessTokens",
    labelFallback: "Access Tokens",
    subtitleKey: "settingsAccessTokensSubtitle",
    icon: "key",
  },
  {
    id: "settings-feature-flags",
    href: "/system/settings/feature-flags",
    i18nKey: "settingsFeatureFlags",
    subtitleKey: "settingsFeatureFlagsSubtitle",
    icon: "flag",
  },
  {
    id: "settings-cache",
    href: "/system/settings/cache",
    i18nKey: "settingsCache",
    subtitleKey: "settingsCacheSubtitle",
    icon: "memory",
  },
  {
    id: "settings-sidebar",
    href: "/system/settings/sidebar",
    i18nKey: "settingsSidebar",
    subtitleKey: "settingsSidebarSubtitle",
    icon: "view_sidebar",
  },
];

const ACCESS_ITEMS: readonly SidebarItemDefinition[] = [
  {
    id: "tenants",
    href: "/access/tenants",
    i18nKey: "tenants",
    subtitleKey: "tenantsSubtitle",
    icon: "groups",
  },
  {
    id: "access-users",
    href: "/access/users",
    i18nKey: "accessUsers",
    labelFallback: "Users",
    subtitleFallback: "Tenant users and administrators",
    icon: "people",
  },
  {
    id: "access-roles",
    href: "/access/roles",
    i18nKey: "accessRoles",
    labelFallback: "Roles",
    subtitleFallback: "Instance and tenant permissions",
    icon: "shield",
  },
];

const HELP_ITEMS: readonly SidebarItemDefinition[] = [
  {
    id: "docs",
    href: "/docs",
    i18nKey: "docs",
    subtitleKey: "docsSubtitle",
    icon: "menu_book",
    external: true,
  },
  {
    id: "issues",
    href: "https://github.com/reddb-io/red-router/issues",
    i18nKey: "issues",
    subtitleKey: "issuesSubtitle",
    icon: "bug_report",
    external: true,
  },
];

// ─── Sections ────────────────────────────────────────────────────────────────

export const SIDEBAR_SECTIONS: readonly SidebarSectionDefinition[] = [
  {
    id: "home",
    titleKey: "home",
    titleFallback: "Home",
    children: HOME_ITEMS,
    showTitle: false,
  },
  {
    id: "omni-proxy",
    titleKey: "omniProxySection",
    titleFallback: "Proxy",
    children: [
      ...OMNI_PROXY_ITEMS,
      COMPRESSION_CONTEXT_GROUP,
      TOOLS_GROUP,
      INTEGRATIONS_GROUP,
      PROXY_ITEM,
    ],
  },
  {
    id: "analytics",
    titleKey: "analyticsSection",
    titleFallback: "Analytics",
    children: ANALYTICS_ITEMS,
  },
  {
    id: "costs",
    titleKey: "costsSection",
    titleFallback: "Costs",
    children: COSTS_ITEMS,
  },
  {
    id: "monitoring",
    titleKey: "monitoringSection",
    titleFallback: "Monitoring",
    children: [...MONITORING_ITEMS, LOGS_GROUP, AUDIT_GROUP, SYSTEM_GROUP],
  },
  {
    id: "devtools",
    titleKey: "devtoolsSection",
    titleFallback: "Dev Tools",
    children: DEVTOOLS_ITEMS,
  },
  {
    id: "agentic-features",
    titleKey: "agenticFeaturesSection",
    titleFallback: "Agentic Features",
    children: AGENTIC_FEATURES_ITEMS,
  },
  {
    id: "other-features",
    titleKey: "otherFeaturesSection",
    titleFallback: "Other Features",
    children: [...OTHER_FEATURES_ITEMS, BATCH_GROUP],
  },
  { id: "access", titleKey: "access", titleFallback: "Access", children: ACCESS_ITEMS },
  {
    id: "configuration",
    titleKey: "configurationSection",
    titleFallback: "Configuration",
    children: CONFIGURATION_ITEMS,
  },
  {
    id: "help",
    titleKey: "helpSection",
    titleFallback: "Help",
    children: HELP_ITEMS,
  },
] as const;
