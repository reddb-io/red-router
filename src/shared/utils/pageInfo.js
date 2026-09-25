// Page identity per dashboard route: the title, description and breadcrumbs the
// layout renders in the page heading (the page's one H1).
import { OAUTH_PROVIDERS, APIKEY_PROVIDERS } from "@/shared/constants/config";
import { MEDIA_PROVIDER_KINDS, AI_PROVIDERS } from "@/shared/constants/providers";
import { getProviderIconSrc } from "@/shared/utils/providerIcon";

// Detail pages render their own richer heading (icon, status, external links)
// and keep their H1; the layout shows only their breadcrumbs.
const OWN_HEADING = [
  /^\/dashboard\/setup$/,
  /^\/dashboard\/providers\/(?!new$)[^/]+$/,
  /^\/dashboard\/tools-providers\/[^/]+\/[^/]+$/,
  /^\/dashboard\/cli-tools\/[^/]+$/,
  /^\/dashboard\/keys\/[^/]+$/,
];

export function hasOwnHeading(pathname) {
  return OWN_HEADING.some((re) => re.test(pathname || ""));
}

export function getPageInfo(pathname) {
  if (!pathname) return { title: "", description: "", breadcrumbs: [] };

  // Tool provider detail: /dashboard/tools-providers/[kind]/[id]
  const mediaDetailMatch = pathname.match(/\/tools-providers\/([^/]+)\/([^/]+)$/);
  if (mediaDetailMatch) {
    const kindId = mediaDetailMatch[1];
    const providerId = mediaDetailMatch[2];
    const kindConfig = MEDIA_PROVIDER_KINDS.find((k) => k.id === kindId);
    const provider = AI_PROVIDERS[providerId];
    return {
      title: provider?.name || providerId,
      description: "",
      breadcrumbs: [
        { label: "Tools Providers", href: `/dashboard/tools-providers/${kindId}` },
        { label: kindConfig?.label || kindId, href: `/dashboard/tools-providers/${kindId}` },
        { label: provider?.name || providerId, image: getProviderIconSrc(providerId) },
      ],
    };
  }

  // Tool provider kind: /dashboard/tools-providers/[kind]
  const mediaKindMatch = pathname.match(/\/tools-providers\/([^/]+)$/);
  if (mediaKindMatch) {
    const kindId = mediaKindMatch[1];
    const kindConfig = MEDIA_PROVIDER_KINDS.find((k) => k.id === kindId);
    return {
      title: kindConfig?.label || kindId,
      description: `Manage your ${kindConfig?.label || kindId} providers`,
      icon: kindConfig?.icon || "perm_media",
      breadcrumbs: [],
    };
  }

  // Provider detail page: /dashboard/providers/[id]
  const providerMatch = pathname.match(/\/providers\/([^/]+)$/);
  if (providerMatch) {
    const providerId = providerMatch[1];
    const providerInfo =
      OAUTH_PROVIDERS[providerId] || APIKEY_PROVIDERS[providerId];
    if (providerInfo) {
      return {
        title: providerInfo.name,
        description: "",
        breadcrumbs: [
          { label: "Providers", href: "/dashboard/providers" },
          {
            label: providerInfo.name,
            image: getProviderIconSrc(providerInfo.id),
          },
        ],
      };
    }
  }

  if (pathname === "/dashboard/providers/new")
    return {
      title: "Add New Provider",
      description: "Configure a new AI provider to use with your applications.",
      breadcrumbs: [{ label: "Providers", href: "/dashboard/providers" }, { label: "Add New Provider" }],
    };

  if (pathname.includes("/providers") && !pathname.includes("/tools-providers"))
    return {
      title: "Providers",
      description: "Manage your AI provider connections",
      icon: "dns",
      breadcrumbs: [],
    };
  if (pathname === "/dashboard/models")
    return {
      title: "Models",
      description: "One entry per model, whoever serves it: choose which offers a flat model id uses, and in what order.",
      icon: "view_list",
      breadcrumbs: [],
    };
  if (pathname.includes("/combos"))
    return {
      title: "Combos",
      description: "One model name, several models behind it",
      icon: "layers",
      breadcrumbs: [],
    };
  // Before "/usage", which "/usage-sinks" also contains.
  if (pathname.includes("/usage-sinks"))
    return {
      title: "Usage Sinks",
      description: "Send usage to your billing system: every request, or totals per API key on a schedule.",
      icon: "outbox",
      breadcrumbs: [],
    };
  if (pathname.includes("/usage") || pathname === "/dashboard")
    return {
      title: "Usage",
      description: "Inspect traffic, token volume, estimated cost, and individual requests.",
      icon: "bar_chart",
      breadcrumbs: [],
    };
  if (pathname.includes("/auth-files"))
    return {
      title: "Auth Files",
      description: "Map provider credentials stored in the local database",
      icon: "vpn_key",
      breadcrumbs: [],
    };
  if (pathname.includes("/quota"))
    return {
      title: "Quota Tracker",
      description: "Track and manage your API quota limits",
      icon: "data_usage",
      breadcrumbs: [],
    };
  if (pathname.includes("/mitm"))
    return {
      title: "MITM Proxy",
      description: "Intercept CLI tool traffic and route through RedRouter",
      icon: "security",
      breadcrumbs: [],
    };
  if (pathname.includes("/token-saver"))
    return {
      title: "Token Saver",
      description: "Compress prompts and outputs to save tokens",
      icon: "savings",
      breadcrumbs: [],
    };
  if (pathname.includes("/cli-tools"))
    return {
      title: "CLI Tools",
      description: "Configure CLI tools",
      icon: "terminal",
      breadcrumbs: [],
    };
  if (pathname.includes("/proxy-pools"))
    return {
      title: "Proxy Pools",
      description: "Manage your proxy pool configurations",
      icon: "lan",
      breadcrumbs: [],
    };
  if (pathname.includes("/skills"))
    return {
      title: "Skills",
      description: "Give an AI client precise instructions for configuring and operating RedRouter.",
      icon: "extension",
      breadcrumbs: [],
    };
  if (pathname.includes("/endpoint"))
    return {
      title: "Endpoint",
      description: "API endpoint configuration",
      icon: "api",
      breadcrumbs: [],
    };
  if (pathname.includes("/profile"))
    return {
      title: "Settings",
      description: "Manage your preferences",
      icon: "settings",
      breadcrumbs: [],
    };
  if (pathname.includes("/translator"))
    return {
      title: "Translator Debug",
      description: "Replay request flow — matches log files",
      icon: "translate",
      breadcrumbs: [],
    };
  if (pathname.includes("/console-log"))
    return {
      title: "Console Log",
      description: "Live server console output",
      icon: "monitor",
      breadcrumbs: [],
    };
  if (pathname === "/dashboard/setup")
    return {
      title: "Setup",
      description: "Connect providers, create a key, and validate the endpoint",
      icon: "route",
      breadcrumbs: [],
    };
  return { title: "", description: "", breadcrumbs: [] };
}
