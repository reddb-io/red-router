export type SpaPageId =
  | "overview"
  | "endpoints"
  | "providers"
  | "resilience"
  | "models"
  | "combos"
  | "keys"
  | "budgets"
  | "usage-sinks"
  | "usage"
  | "legacy-usage"
  | "organizations"
  | "audit"
  | "oidc";

export interface SpaPageRoute {
  id: SpaPageId;
  path: string;
  label: string;
  aliases?: readonly string[];
  prefixes?: readonly string[];
}

export const spaPageRoutes: readonly SpaPageRoute[] = [
  {
    id: "overview",
    path: "/dashboard",
    label: "Overview",
    aliases: [
      "/",
      "/home",
      "/dashboard/health",
      "/dashboard/runtime",
      "/dashboard/provider-stats",
      "/observe/health",
      "/observe/health/runtime",
      "/home/analytics",
    ],
  },
  {
    id: "endpoints",
    path: "/dashboard/endpoint",
    label: "Endpoint",
    aliases: ["/proxy/endpoint"],
  },
  {
    id: "providers",
    path: "/dashboard/providers",
    label: "Providers",
    aliases: ["/proxy/providers"],
    prefixes: ["/dashboard/providers/", "/proxy/providers/"],
  },
  {
    id: "resilience",
    path: "/dashboard/provider-resilience",
    label: "Resilience",
    aliases: [
      "/dashboard/resilience/connections",
      "/dashboard/settings/resilience",
      "/dashboard/limits",
      "/dashboard/quota",
      "/observe/health/connections",
      "/observe/costs/quota",
    ],
  },
  {
    id: "models",
    path: "/dashboard/model-catalog",
    label: "Models",
    aliases: ["/dashboard/models", "/dashboard/discovery", "/proxy/models", "/tools/discovery"],
  },
  {
    id: "combos",
    path: "/dashboard/combos",
    label: "Combos",
    aliases: ["/dashboard/auto-combo", "/dashboard/radar/combos", "/proxy/combos"],
    prefixes: ["/dashboard/combos/", "/proxy/combos/"],
  },
  {
    id: "keys",
    path: "/dashboard/api-manager",
    label: "API keys",
    aliases: [
      "/dashboard/api-manager/routing",
      "/dashboard/settings/access-tokens",
      "/proxy/keys",
      "/proxy/keys/routing",
      "/system/settings/access-tokens",
    ],
  },
  {
    id: "budgets",
    path: "/dashboard/budgets",
    label: "Budgets",
    aliases: [
      "/dashboard/costs/budget",
      "/dashboard/costs/quota-share",
      "/observe/costs/budget",
      "/observe/costs/quota-share",
    ],
  },
  {
    id: "usage-sinks",
    path: "/dashboard/usage-sinks",
    label: "Usage destinations",
    aliases: [
      "/dashboard/log-export",
      "/dashboard/webhooks",
      "/observe/log-export",
      "/observe/webhooks",
    ],
  },
  {
    id: "usage",
    path: "/dashboard/usage",
    label: "Usage report",
    aliases: [
      "/dashboard/costs",
      "/dashboard/analytics",
      "/dashboard/activity",
      "/dashboard/logs",
      "/dashboard/logs/activity",
      "/observe/costs",
      "/observe/logs",
      "/observe/logs/activity",
    ],
  },
  {
    id: "legacy-usage",
    path: "/dashboard/legacy-usage",
    label: "Usage history",
    aliases: ["/observe/logs/history"],
  },
  {
    id: "organizations",
    path: "/dashboard/organizations",
    label: "Organizations",
    aliases: [
      "/dashboard/tenants",
      "/dashboard/users",
      "/dashboard/roles",
      "/system/organizations",
      "/system/users",
      "/system/roles",
    ],
  },
  {
    id: "audit",
    path: "/dashboard/audit",
    label: "Audit log",
    aliases: ["/observe/audit"],
    prefixes: ["/dashboard/audit/", "/observe/audit/"],
  },
  {
    id: "oidc",
    path: "/dashboard/oidc",
    label: "Single sign-on",
    aliases: ["/dashboard/settings/security", "/system/settings/security", "/system/settings/oidc"],
  },
] as const;

function normalizePath(path: string): string {
  const value = path.split(/[?#]/, 1)[0]?.replace(/\/+$/, "") || "/";
  return value.startsWith("/") ? value : `/${value}`;
}

export function resolveSpaPage(path: string): SpaPageRoute | null {
  const normalized = normalizePath(path);
  return (
    spaPageRoutes.find(
      (page) =>
        page.path === normalized ||
        page.aliases?.includes(normalized) ||
        page.prefixes?.some((prefix) => normalized.startsWith(prefix))
    ) ?? null
  );
}
