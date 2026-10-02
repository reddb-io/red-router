"use client";

import { CircleAlert, CircleQuestionMark, Puzzle, SearchX, X } from "lucide-react";
import Icon from "@/shared/components/Icon";
import TrafficConfigurationGuide from "@/shared/components/routing/TrafficConfigurationGuide";
import { useState, useEffect, useCallback, useMemo, Suspense } from "react";
import { Card, CardSkeleton, Badge, Button, CollapsibleSection } from "@/shared/components";
import { tabs } from "@/shared/design-system/contracts/tabs.variants";
import {
  AGGREGATOR_PROVIDER_IDS,
  EMBEDDING_RERANK_PROVIDER_IDS,
  ENTERPRISE_CLOUD_PROVIDER_IDS,
  IDE_PROVIDER_IDS,
  IMAGE_ONLY_PROVIDER_IDS,
  VIDEO_PROVIDER_IDS,
} from "@/shared/constants/providers";
import { partitionNoAuthEntriesByBlocked } from "@/shared/utils/noAuthProviders";
import { useRouter, useSearchParams } from "next/navigation";
import { getErrorCode, getRelativeTime } from "@/shared/utils";
import {
  isProviderConnectionConnected,
  isProviderConnectionErrored,
} from "@/shared/utils/providerConnectionStatus";
import { pickDisplayValue } from "@/shared/utils/maskEmail";
import useEmailPrivacyStore from "@/store/emailPrivacyStore";
import { useNotificationStore } from "@/store/notificationStore";
import { useTranslations } from "next-intl";
import { useSyncedModelsByProvider } from "./hooks/useSyncedModelsByProvider";
import { useProviderUrlFilters } from "./hooks/useProviderUrlFilters";
import {
  buildStaticProviderEntries,
  buildCompatibleProviderGroups,
  sortProviderEntriesByName,
  connectionMatchesProviderCard,
  filterConfiguredProviderEntries,
  shouldFilterProviderEntriesForDisplayMode,
  shouldShowProviderSection,
  upsertProviderNodeById,
  loadProviderPageData,
} from "./providerPageUtils";
import type { ProviderEntry, OpenRouterProviderStatsEntry } from "./providerPageUtils";
import { OpenRouterProviderStatsProvider } from "./context/openRouterProviderStatsContext";
import {
  readProviderViewPreference,
  shouldSyncProviderDisplayMode,
  writeProviderDisplayModePreference,
  writeProviderViewPreference,
  type ProviderDisplayMode,
  type ProviderView,
} from "./providerPageStorage";
import {
  countEnabledProviderEntries,
  filterProviderEntriesByView,
  type ProviderAvailabilityMap,
  normalizeProviderAvailability,
} from "./providerView";
import { providerText, type ProviderMessageTranslator } from "./providerText";
import {
  getCodexEffectiveServiceTier,
  getCodexGlobalServiceMode,
  type CodexGlobalServiceMode,
} from "@/lib/providers/codexFastTier";
import dynamic from "next/dynamic";
const AddCompatibleProviderModal = dynamic(
  () => import("./components/AddCompatibleProviderModal"),
  { ssr: false }
);
const ImportProvidersFromFileModal = dynamic(
  () =>
    import("./components/ImportProvidersFromFileModal").then((m) => m.ImportProvidersFromFileModal),
  { ssr: false }
);
import NoAuthProvidersSection from "./components/NoAuthProvidersSection";
import FreeSourcesPanel from "./components/FreeSourcesPanel";
import ProviderCatalogueList from "./components/ProviderCatalogueList";
import HighlightableProviderCard from "./components/HighlightableProviderCard";
import ProviderCountBadge from "./components/ProviderCountBadge";
import ProviderSummaryCard from "./components/ProviderSummaryCard";
import DeprecatedProviderBanner from "./components/DeprecatedProviderBanner";
import {
  buildCompactProviderEntriesForPage,
  getCompactProviderAuthType,
} from "./providerCompactMode";

type DashboardProviderInfo = {
  id?: string;
  name: string;
  color?: string;
  apiType?: string;
  deprecated?: boolean;
  deprecationReason?: string;
  hasFree?: boolean;
  freeNote?: string;
  [key: string]: unknown;
};

type DashboardProviderEntry = ProviderEntry<DashboardProviderInfo>;

function countConfigured<T>(entries: ProviderEntry<T>[]) {
  return {
    configured: entries.filter((entry) => Number(entry.stats?.total || 0) > 0).length,
    total: entries.length,
  };
}

function dedupeProviderEntries(entries: DashboardProviderEntry[]): DashboardProviderEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.providerId)) return false;
    seen.add(entry.providerId);
    return true;
  });
}

function providerEntryHasFree(entry: DashboardProviderEntry): boolean {
  return entry.provider.hasFree === true;
}

type ProviderBatchTestResult = {
  connectionId?: string;
  connectionName?: string;
  provider?: string;
  valid?: boolean;
  latencyMs?: number;
  diagnosis?: { type?: string };
};

type ProviderBatchTestResults = {
  mode?: string;
  results?: ProviderBatchTestResult[];
  summary?: {
    total?: number;
    passed?: number;
    failed?: number;
  };
  error?: string | { message?: string };
};

function getConnectionErrorTag(connection, t: ProviderMessageTranslator) {
  if (!connection) return null;

  const explicitType = connection.lastErrorType;
  if (explicitType === "runtime_error") return providerText(t, "errorTypeRuntime", "Runtime");
  if (
    explicitType === "upstream_auth_error" ||
    explicitType === "auth_missing" ||
    explicitType === "token_refresh_failed" ||
    explicitType === "token_expired"
  ) {
    return providerText(t, "errorTypeUpstreamAuth", "Auth");
  }
  if (explicitType === "upstream_rate_limited") {
    return providerText(t, "errorTypeRateLimited", "Rate limited");
  }
  if (explicitType === "upstream_unavailable") {
    return providerText(t, "errorTypeUpstreamUnavailable", "Server error");
  }
  if (explicitType === "network_error") {
    return providerText(t, "errorTypeNetworkError", "Network");
  }

  const numericCode = Number(connection.errorCode);
  if (Number.isFinite(numericCode) && numericCode >= 400) {
    return String(numericCode);
  }

  const fromMessage = getErrorCode(connection.lastError);
  if (fromMessage === "401" || fromMessage === "403") {
    return providerText(t, "errorTypeUpstreamAuth", "Auth");
  }
  if (fromMessage && fromMessage !== "ERR") return fromMessage;

  const msg = (connection.lastError || "").toLowerCase();
  if (msg.includes("runtime") || msg.includes("not runnable") || msg.includes("not installed"))
    return providerText(t, "errorTypeRuntime", "Runtime");
  if (
    msg.includes("invalid api key") ||
    msg.includes("token invalid") ||
    msg.includes("revoked") ||
    msg.includes("unauthorized")
  )
    return providerText(t, "errorTypeUpstreamAuth", "Auth");

  return "ERR";
}

// OAuth-env repair status fetch, extracted so the callback below only sets
// state after the await (errors come back as `null` instead of a setState
// inside the catch block, which the react-hooks compiler rules reject when the
// callback is invoked from an effect).
async function loadOauthEnvRepairStatus(): Promise<{
  available: boolean;
  missingCount: number;
} | null> {
  try {
    const res = await fetch("/api/system/env/repair", { cache: "no-store" });
    const data = await res.json();
    if (!res.ok) return null;
    return {
      available: Boolean(data.available),
      missingCount: Number(data.missingCount || 0),
    };
  } catch {
    return null;
  }
}

function ProvidersPageContent() {
  const router = useRouter();
  const [connections, setConnections] = useState<any[]>([]);
  const [providerNodes, setProviderNodes] = useState<any[]>([]);
  const [ccCompatibleProviderEnabled, setCcCompatibleProviderEnabled] = useState(false);
  const [blockedProviders, setBlockedProviders] = useState<string[]>([]);
  const [expirations, setExpirations] = useState<any>(null);
  const [codexGlobalServiceMode, setCodexGlobalServiceMode] =
    useState<CodexGlobalServiceMode>("none");
  const [loading, setLoading] = useState(true);
  // The stored view is read once when the component mounts. Nothing view-dependent renders while
  // `loading` is true (the skeleton), so this cannot cause a hydration mismatch; without storage
  // the page opens on the default "Enabled" view.
  const [providerView, setProviderView] = useState<ProviderView>(() =>
    readProviderViewPreference()
  );
  const [providerAvailability, setProviderAvailability] = useState<ProviderAvailabilityMap | null>(
    null
  );
  const [showAddCompatibleModal, setShowAddCompatibleModal] = useState(false);
  const [showAddAnthropicCompatibleModal, setShowAddAnthropicCompatibleModal] = useState(false);
  const [showAddCcCompatibleModal, setShowAddCcCompatibleModal] = useState(false);
  const [showImportFromFileModal, setShowImportFromFileModal] = useState(false);
  const [testingMode, setTestingMode] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<any>(null);
  const [providerDisplayMode, setProviderDisplayMode] = useState<ProviderDisplayMode>("all");
  const [oauthEnvRepairStatus, setOauthEnvRepairStatus] = useState<{
    available: boolean;
    missingCount: number;
  } | null>(null);
  const [repairingEnv, setRepairingEnv] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [modelSearchQuery, setModelSearchQuery] = useState("");
  const liveModelsByProviderId = useSyncedModelsByProvider();
  const [showFreeOnly, setShowFreeOnly] = useState(false);
  const [openRouterProviderStats, setOpenRouterProviderStats] = useState<
    OpenRouterProviderStatsEntry[]
  >([]);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  // #4240: media-category (serviceKind) filter — composes with activeCategory,
  // search and configured-only. null = no serviceKind filter.
  const [activeServiceKind, setActiveServiceKind] = useState<string | null>(null);
  const notify = useNotificationStore();
  const sectionCategoryAliases: Record<string, string> = {
    cloud: "cloudagent",
    noauth: "no-auth",
    proxy: "upstream-proxy",
    web: "webcookie",
  };
  const showSection = (category: string) => {
    const normalizedCategory = sectionCategoryAliases[category] ?? category;
    return shouldShowProviderSection(normalizedCategory, activeCategory, showFreeOnly);
  };
  const t = useTranslations("providers");
  const tc = useTranslations("common");
  const webCookieProvidersDesc = providerText(
    t,
    "webCookieProvidersDesc",
    "These providers use browser web sessions, cookies, or web tokens instead of API keys. Open a provider to add the required session credential."
  );
  const ccCompatibleLabel = t("ccCompatibleLabel");
  const addCcCompatibleLabel = t("addCcCompatible");
  const searchParams = useSearchParams();

  const { displayModePreferenceReady } = useProviderUrlFilters({
    searchParams,
    providerDisplayMode,
    setProviderDisplayMode,
    searchQuery,
    setSearchQuery,
    modelSearchQuery,
    setModelSearchQuery,
    activeCategory,
    setActiveCategory,
    showFreeOnly,
    setShowFreeOnly,
    activeServiceKind,
    setActiveServiceKind,
  });

  useEffect(() => {
    const fetchData = async () => {
      try {
        // Each request is time-bounded (see loadProviderPageData); a single
        // stalled connection can no longer wedge `loading` on `true` and freeze
        // the page on its skeleton forever.
        const data = await loadProviderPageData();
        setConnections(data.connections);
        setProviderAvailability(data.providerAvailability);
        setProviderNodes(data.providerNodes);
        setCcCompatibleProviderEnabled(data.ccCompatibleProviderEnabled);
        if (data.expirations) setExpirations(data.expirations);
        if (data.blockedProviders) setBlockedProviders(data.blockedProviders);
        setCodexGlobalServiceMode(getCodexGlobalServiceMode(data.settings));
        setOpenRouterProviderStats(data.openRouterProviderStats);
      } catch (error) {
        console.log("Error fetching data:", error);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  const handleProviderViewChange = useCallback((view: ProviderView) => {
    setProviderView(view);
    writeProviderViewPreference(view);
  }, []);

  // Free sources are switched on/off in their own panel; re-read what is enabled afterwards so
  // the "Enabled" view and the counts stay in step with it.
  const refreshProviderAvailability = useCallback(async () => {
    try {
      const res = await fetch("/api/providers", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      const next = normalizeProviderAvailability(data?.providerAvailability);
      if (next) setProviderAvailability(next);
      if (Array.isArray(data?.connections)) setConnections(data.connections);
    } catch {
      // Keep the previous availability; the next visit reloads it.
    }
  }, []);

  useEffect(() => {
    if (!shouldSyncProviderDisplayMode(displayModePreferenceReady, loading)) return;

    const storedDisplayMode =
      connections.length === 0 && providerDisplayMode === "configured"
        ? "all"
        : providerDisplayMode;
    writeProviderDisplayModePreference(storedDisplayMode);
  }, [connections.length, displayModePreferenceReady, providerDisplayMode, loading]);

  // "No connections → fall back to the 'all' view" is a state adjustment
  // derived from other state, applied during render (self-invalidating guard,
  // converges in one extra pass) instead of a synchronous setState effect.
  if (
    shouldSyncProviderDisplayMode(displayModePreferenceReady, loading) &&
    connections.length === 0 &&
    providerDisplayMode === "configured"
  ) {
    setProviderDisplayMode("all");
  }

  const fetchOauthEnvRepairStatus = useCallback(async () => {
    setOauthEnvRepairStatus(await loadOauthEnvRepairStatus());
  }, []);

  useEffect(() => {
    const run = async () => {
      const status = await loadOauthEnvRepairStatus();
      setOauthEnvRepairStatus(status);
    };
    void run();
  }, []);

  const handleRepairEnv = async () => {
    if (!oauthEnvRepairStatus?.available || repairingEnv) return;

    setRepairingEnv(true);
    try {
      const res = await fetch("/api/system/env/repair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || t("repairEnvFailed"));
      }
      notify.success(
        data.backupPath ? `${t("repairEnvSuccess")} (${data.backupPath})` : t("repairEnvSuccess")
      );
      await fetchOauthEnvRepairStatus();
    } catch (error) {
      notify.error(error instanceof Error ? error.message : t("repairEnvFailed"));
    } finally {
      setRepairingEnv(false);
    }
  };

  const getProviderStats = (providerId, authType) => {
    const providerConnections = connections.filter((c) =>
      connectionMatchesProviderCard(c, providerId, authType)
    );

    const connected = providerConnections.filter((connection) =>
      isProviderConnectionConnected(connection)
    ).length;

    const errorConns = providerConnections.filter((connection) =>
      isProviderConnectionErrored(connection)
    );

    const error = errorConns.length;
    const total = providerConnections.length;

    // Check if all connections are manually disabled
    const allDisabled = total > 0 && providerConnections.every((c) => c.isActive === false);

    // Get latest error info
    const latestError = errorConns.sort(
      (a: any, b: any) =>
        (new Date(b.lastErrorAt || 0) as any) - (new Date(a.lastErrorAt || 0) as any)
    )[0];
    const errorCode = latestError ? getConnectionErrorTag(latestError, t) : null;
    const errorTime = latestError?.lastErrorAt ? getRelativeTime(latestError.lastErrorAt) : null;

    // Check expirations
    const providerExpirations =
      expirations?.list?.filter((e: any) => e.provider === providerId) || [];
    const hasExpired = providerExpirations.some((e: any) => e.status === "expired");
    const hasExpiringSoon = providerExpirations.some((e: any) => e.status === "expiring_soon");
    let expiryStatus = null;
    if (hasExpired) expiryStatus = "expired";
    else if (hasExpiringSoon) expiryStatus = "expiring_soon";

    const codexConnectionServiceTiers = [
      ...new Set(
        providerConnections
          .map((connection) =>
            getCodexEffectiveServiceTier(connection.providerSpecificData, "none")
          )
          .filter((tier) => tier !== "default")
      ),
    ];
    const codexServiceTier =
      providerId === "codex"
        ? codexGlobalServiceMode !== "none"
          ? codexGlobalServiceMode
          : codexConnectionServiceTiers.length === 1
            ? codexConnectionServiceTiers[0]
            : null
        : null;

    // Count API keys in "warning" state across all connections, and (#10261)
    // aggregate a SANITIZED reasons summary (max failure count + most recent
    // failure time — never the raw upstream error text) so the warning badge
    // can expose why connections are flagged instead of a bare count.
    let warningMaxFailures = 0;
    let warningLatestFailureAt: string | null = null;
    const warning = providerConnections.reduce((warnCount, conn) => {
      const health = (conn as any).providerSpecificData?.apiKeyHealth as
        | Record<string, { status: string; failures?: number; lastFailure?: string | null }>
        | undefined;
      if (!health) return warnCount;
      const warningEntries = Object.values(health).filter((h) => h.status === "warning");
      for (const entry of warningEntries) {
        warningMaxFailures = Math.max(warningMaxFailures, entry.failures ?? 0);
        if (
          entry.lastFailure &&
          (!warningLatestFailureAt || entry.lastFailure > warningLatestFailureAt)
        ) {
          warningLatestFailureAt = entry.lastFailure;
        }
      }
      return warnCount + warningEntries.length;
    }, 0);
    const warningLastFailureRelative = warningLatestFailureAt
      ? getRelativeTime(warningLatestFailureAt)
      : null;

    return {
      connected,
      error,
      warning,
      warningMaxFailures,
      warningLastFailureRelative,
      total,
      errorCode,
      errorTime,
      allDisabled,
      expiryStatus,
      codexServiceTier,
    };
  };

  // Toggle all connections for a provider on/off
  const handleToggleProvider = async (providerId: string, authType: string, newActive: boolean) => {
    const matchesToggle = (c: { provider: string; authType?: string }) =>
      connectionMatchesProviderCard(c, providerId, authType as "oauth" | "free" | "apikey");
    const providerConns = connections.filter(matchesToggle);
    // Optimistically update UI
    setConnections((prev) =>
      prev.map((c) => (matchesToggle(c) ? { ...c, isActive: newActive } : c))
    );
    // Fire API calls in parallel
    await Promise.allSettled(
      providerConns.map((c) =>
        fetch(`/api/providers/${c.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isActive: newActive }),
        })
      )
    );
  };

  const handleBatchTest = async (mode, providerId = null) => {
    if (testingMode) return;
    setTestingMode(mode === "provider" ? providerId : mode);
    setTestResults(null);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 90_000); // 90s max
    try {
      const res = await fetch("/api/providers/test-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, providerId }),
        signal: controller.signal,
      });
      let data: any;
      try {
        data = await res.json();
      } catch {
        // Response body is not valid JSON (e.g. truncated due to timeout)
        data = { error: t("providerTestFailed"), results: [], summary: null };
      }
      setTestResults({
        ...data,
        // Normalize error: if API returns an error object { message, details }, extract the string
        error: data.error
          ? typeof data.error === "object"
            ? data.error.message || data.error.error || JSON.stringify(data.error)
            : String(data.error)
          : null,
      });
      if (data?.summary) {
        const { passed, failed, total } = data.summary;
        if (failed === 0) notify.success(t("allTestsPassed", { total }));
        else notify.warning(t("testSummary", { passed, failed, total }));
      }
    } catch (error: any) {
      const isAbort = error?.name === "AbortError";
      const msg = isAbort ? t("providerTestTimeout") : t("providerTestFailed");
      setTestResults({ error: msg, results: [], summary: null });
      notify.error(msg);
    } finally {
      clearTimeout(timeoutId);
      setTestingMode(null);
    }
  };

  const compatibleProviderGroups = useMemo(
    () =>
      buildCompatibleProviderGroups(providerNodes, {
        openaiCompatibleName: t("openaiCompatibleName"),
        anthropicCompatibleName: t("anthropicCompatibleName"),
        claudeCodeCompatibleName: ccCompatibleLabel,
      }),
    [ccCompatibleLabel, providerNodes, t]
  );
  const compatibleProviders = compatibleProviderGroups.openai;
  const anthropicCompatibleProviders = compatibleProviderGroups.anthropic;
  const ccCompatibleProviders = compatibleProviderGroups.claudeCode;

  const effectiveProviderDisplayMode =
    providerDisplayMode === "configured" && connections.length === 0 ? "all" : providerDisplayMode;
  const effectiveShowConfiguredOnly = shouldFilterProviderEntriesForDisplayMode(
    effectiveProviderDisplayMode,
    connections.length
  );
  const isCompactProviderDisplay = effectiveProviderDisplayMode === "compact";

  // Every list on the page goes through the same two steps: the operator's filters (search, media,
  // free, configured-only), then the view. "Enabled" keeps only providers the operator turned on,
  // so keyless sources that were never enabled never show up outside "All providers".
  const scopeEntries = <TProvider,>(
    entries: ProviderEntry<TProvider>[],
    freeOnly: boolean = showFreeOnly
  ): ProviderEntry<TProvider>[] =>
    filterProviderEntriesByView(
      filterConfiguredProviderEntries(
        entries,
        providerView === "all" ? false : effectiveShowConfiguredOnly,
        searchQuery,
        freeOnly,
        modelSearchQuery,
        activeServiceKind,
        liveModelsByProviderId,
        connections
      ),
      providerView,
      providerAvailability
    );

  const oauthProviderEntriesAll = buildStaticProviderEntries("oauth", getProviderStats);
  const oauthProviderEntries = scopeEntries(oauthProviderEntriesAll);

  const rawNoAuthEntriesAll = buildStaticProviderEntries("no-auth", getProviderStats);
  // Partition rather than drop: blocked no-auth providers stay surfaced on the page
  // (rendered with a "Disabled" badge + Enable button) instead of silently vanishing,
  // which left users unable to find/restore a disabled no-auth provider (#5166/#5183).
  // `noAuthEntriesAll` keeps only the visible (non-blocked) entries, so every downstream
  // aggregate/count/model list that consumes it is unchanged.
  const { visible: noAuthEntriesAll, blocked: blockedNoAuthEntries } =
    partitionNoAuthEntriesByBlocked(rawNoAuthEntriesAll, blockedProviders);
  const noAuthEntries = scopeEntries(noAuthEntriesAll);

  const apiKeyProviderEntriesAll = buildStaticProviderEntries("apikey", getProviderStats);
  const llmProviderEntriesAll = apiKeyProviderEntriesAll.filter(
    (entry) =>
      !IMAGE_ONLY_PROVIDER_IDS.has(entry.providerId) &&
      !AGGREGATOR_PROVIDER_IDS.has(entry.providerId) &&
      !ENTERPRISE_CLOUD_PROVIDER_IDS.has(entry.providerId) &&
      !VIDEO_PROVIDER_IDS.has(entry.providerId) &&
      !EMBEDDING_RERANK_PROVIDER_IDS.has(entry.providerId)
  );
  const llmProviderEntries = scopeEntries(llmProviderEntriesAll);
  const aggregatorProviderEntriesAll = apiKeyProviderEntriesAll.filter((entry) =>
    AGGREGATOR_PROVIDER_IDS.has(entry.providerId)
  );
  const aggregatorProviderEntries = scopeEntries(aggregatorProviderEntriesAll);
  const imageProviderEntriesAll = apiKeyProviderEntriesAll.filter((entry) =>
    IMAGE_ONLY_PROVIDER_IDS.has(entry.providerId)
  );
  const imageProviderEntries = scopeEntries(imageProviderEntriesAll);
  const enterpriseProviderEntriesAll = apiKeyProviderEntriesAll.filter((entry) =>
    ENTERPRISE_CLOUD_PROVIDER_IDS.has(entry.providerId)
  );
  const enterpriseProviderEntries = scopeEntries(enterpriseProviderEntriesAll);
  const videoProviderEntriesAll = apiKeyProviderEntriesAll.filter((entry) =>
    VIDEO_PROVIDER_IDS.has(entry.providerId)
  );
  const videoProviderEntries = scopeEntries(videoProviderEntriesAll);
  const embeddingRerankProviderEntriesAll = apiKeyProviderEntriesAll.filter((entry) =>
    EMBEDDING_RERANK_PROVIDER_IDS.has(entry.providerId)
  );
  const embeddingRerankProviderEntries = scopeEntries(embeddingRerankProviderEntriesAll);

  const webCookieProviderEntriesAll = buildStaticProviderEntries("web-cookie", getProviderStats);
  const webCookieProviderEntries = scopeEntries(webCookieProviderEntriesAll);

  const localProviderEntriesAll = buildStaticProviderEntries("local", getProviderStats);
  const localProviderEntries = scopeEntries(localProviderEntriesAll);

  const searchProviderEntriesAll = buildStaticProviderEntries("search", getProviderStats);
  const searchProviderEntries = scopeEntries(searchProviderEntriesAll);

  const audioProviderEntriesAll = buildStaticProviderEntries("audio", getProviderStats);
  const audioProviderEntries = scopeEntries(audioProviderEntriesAll);

  const cloudAgentProviderEntriesAll = buildStaticProviderEntries("cloud-agent", getProviderStats);
  const cloudAgentProviderEntries = scopeEntries(cloudAgentProviderEntriesAll);

  const upstreamProxyEntriesAll = buildStaticProviderEntries("upstream-proxy", getProviderStats);
  const upstreamProxyEntries = scopeEntries(upstreamProxyEntriesAll);

  const compatibleProviderEntriesAll = [
    ...compatibleProviders.map((provider) => ({
      providerId: provider.id,
      provider,
      stats: getProviderStats(provider.id, "apikey"),
      displayAuthType: "compatible" as const,
      toggleAuthType: "apikey" as const,
    })),
    ...anthropicCompatibleProviders.map((provider) => ({
      providerId: provider.id,
      provider,
      stats: getProviderStats(provider.id, "apikey"),
      displayAuthType: "compatible" as const,
      toggleAuthType: "apikey" as const,
    })),
    ...ccCompatibleProviders.map((provider) => ({
      providerId: provider.id,
      provider,
      stats: getProviderStats(provider.id, "apikey"),
      displayAuthType: "compatible" as const,
      toggleAuthType: "apikey" as const,
    })),
  ];
  const compatibleProviderEntries = scopeEntries(compatibleProviderEntriesAll);

  const staticProviderEntriesAll = dedupeProviderEntries([
    ...oauthProviderEntriesAll,
    ...noAuthEntriesAll,
    ...apiKeyProviderEntriesAll,
    ...webCookieProviderEntriesAll,
    ...localProviderEntriesAll,
    ...searchProviderEntriesAll,
    ...audioProviderEntriesAll,
    ...cloudAgentProviderEntriesAll,
    ...upstreamProxyEntriesAll,
  ] as DashboardProviderEntry[]);
  const dashboardProviderEntriesAll = dedupeProviderEntries([
    ...staticProviderEntriesAll,
    ...compatibleProviderEntriesAll,
  ]);
  const freeSectionEntriesAll = dashboardProviderEntriesAll.filter(providerEntryHasFree);
  const freeSectionEntries = scopeEntries(freeSectionEntriesAll, false);

  // IDE providers: subset of oauth/apikey providers that are editors/IDEs with
  // built-in AI subscription. Rendered in a dedicated "IDE Providers" section
  // and excluded from the regular OAuth/API Key sections to avoid duplication.
  const ideProviderEntriesAll = [...oauthProviderEntriesAll, ...apiKeyProviderEntriesAll].filter(
    (e) => IDE_PROVIDER_IDS.has(e.providerId)
  );
  const ideProviderEntries = scopeEntries(ideProviderEntriesAll);

  const oauthOnlyEntriesAll = oauthProviderEntriesAll
    .filter((e) => e.toggleAuthType === "oauth")
    .filter((e) => !IDE_PROVIDER_IDS.has(e.providerId));

  // Web Fetch providers: filter across all entries by serviceKinds
  const webFetchEntriesAll = dedupeProviderEntries(
    [...staticProviderEntriesAll, ...compatibleProviderEntriesAll].filter((e) => {
      const p = e.provider as DashboardProviderInfo & { serviceKinds?: string[] };
      return p.serviceKinds?.includes("webFetch") === true;
    }) as DashboardProviderEntry[]
  );
  const webFetchEntries = scopeEntries(webFetchEntriesAll);

  const compactProviderEntries = buildCompactProviderEntriesForPage({
    activeCategory,
    showFreeOnly,
    freeSectionEntries,
    compatibleProviderEntries,
    oauthProviderEntries,
    ideProviderEntries,
    noAuthEntries,
    upstreamProxyEntries,
    llmProviderEntries,
    aggregatorProviderEntries,
    enterpriseProviderEntries,
    embeddingRerankProviderEntries,
    imageProviderEntries,
    videoProviderEntries,
    webCookieProviderEntries,
    searchProviderEntries,
    webFetchEntries,
    audioProviderEntries,
    localProviderEntries,
    cloudAgentProviderEntries,
    view: providerView,
    providerAvailability,
  });
  // "All providers" lists the whole catalogue alphabetically, one row per provider.
  const catalogueEntries = sortProviderEntriesByName(compactProviderEntries);
  const blockedNoAuthShown = filterProviderEntriesByView(
    blockedNoAuthEntries,
    providerView,
    providerAvailability
  );
  const enabledEntryCount = countEnabledProviderEntries(
    dashboardProviderEntriesAll,
    providerAvailability
  );
  const enabledFreeSourceCount = countEnabledProviderEntries(
    noAuthEntriesAll,
    providerAvailability
  );

  const summaryStats = {
    all: countConfigured(dashboardProviderEntriesAll),
    free: countConfigured(freeSectionEntriesAll),
    noauth: countConfigured(noAuthEntriesAll),
    oauth: countConfigured(oauthOnlyEntriesAll),
    apikey: countConfigured(apiKeyProviderEntriesAll),
    compatible: countConfigured(compatibleProviderEntriesAll),
    webcookie: countConfigured(webCookieProviderEntriesAll),
    search: countConfigured(searchProviderEntriesAll),
    audio: countConfigured(audioProviderEntriesAll),
    local: countConfigured(localProviderEntriesAll),
    upstreamproxy: countConfigured(upstreamProxyEntriesAll),
    cloudagent: countConfigured(cloudAgentProviderEntriesAll),
    ide: countConfigured(ideProviderEntriesAll),
    webfetch: countConfigured(webFetchEntriesAll),
  };
  if (loading) {
    return (
      <div className="flex flex-col gap-8">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  const showNothingEnabledHint =
    providerView === "enabled" && enabledEntryCount === 0 && !searchQuery.trim();
  const viewTabs = tabs();
  const viewItems: { value: ProviderView; label: string; count: number }[] = [
    {
      value: "enabled",
      label: providerText(t, "providerViewEnabled", "Enabled"),
      count: enabledEntryCount,
    },
    {
      value: "free",
      label: providerText(t, "providerViewFree", "Free sources"),
      count: enabledFreeSourceCount,
    },
    {
      value: "all",
      label: providerText(t, "providerViewAll", "All providers"),
      count: dashboardProviderEntriesAll.length,
    },
  ];

  return (
    <OpenRouterProviderStatsProvider entries={openRouterProviderStats}>
      <div className="flex flex-col gap-6">
        <TrafficConfigurationGuide current="connections" />
        <DeprecatedProviderBanner />

        <div className={viewTabs.root()}>
          <div
            role="tablist"
            aria-label={providerText(t, "providerViewLabel", "Provider view")}
            className={viewTabs.list()}
            data-testid="provider-view-tabs"
          >
            {viewItems.map((item) => (
              <button
                key={item.value}
                type="button"
                role="tab"
                id={`provider-view-tab-${item.value}`}
                aria-selected={providerView === item.value}
                aria-controls="provider-view-panel"
                data-state={providerView === item.value ? "active" : "inactive"}
                data-testid={`provider-view-${item.value}`}
                className={viewTabs.trigger()}
                onClick={() => handleProviderViewChange(item.value)}
              >
                {item.label}
                <span className="ml-1.5 text-xs text-text-muted">{item.count}</span>
              </button>
            ))}
          </div>
        </div>

        <div
          role="tabpanel"
          id="provider-view-panel"
          aria-labelledby={`provider-view-tab-${providerView}`}
          className="flex flex-col gap-6"
        >
          {showNothingEnabledHint && (
            <Card padding="lg">
              <div className="flex flex-col items-center justify-center text-center">
                <div className="flex items-center justify-center size-16 rounded-full bg-primary/10 mb-4">
                  <span className="material-symbols-outlined text-[32px] text-primary">dns</span>
                </div>
                <h2 className="text-xl font-semibold text-text-main">
                  {providerText(t, "nothingEnabledTitle", "Nothing is enabled yet")}
                </h2>
                <p className="text-sm text-text-muted mt-2 max-w-md">
                  {providerText(
                    t,
                    "nothingEnabledDesc",
                    "Providers stay off until you enable them. Connect one with a key or an account, or turn on free sources."
                  )}
                </p>
                <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                  <Button icon="add" onClick={() => router.push("/proxy/providers/new")}>
                    {providerText(t, "onboardingWizard", "Provider Onboarding Wizard")}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => handleProviderViewChange("free")}
                    data-testid="provider-hint-free-sources"
                  >
                    {providerText(t, "browseFreeSources", "Browse free sources")}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => handleProviderViewChange("all")}
                    data-testid="provider-hint-all-providers"
                  >
                    {providerText(t, "providerViewAll", "All providers")}
                  </Button>
                  <a
                    href="https://github.com/reddb-io/red-router#-documentation"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg border border-border text-text-muted hover:text-text-main hover:bg-bg-subtle transition-colors"
                  >
                    <Icon icon={CircleQuestionMark} size="md" color="current" />
                    {t("learnMore") || "Learn more"}
                  </a>
                </div>
              </div>
            </Card>
          )}

          {providerView === "free" ? (
            <FreeSourcesPanel onChanged={refreshProviderAvailability} />
          ) : (
            <>
              <ProviderSummaryCard
                showDisplayMode={providerView === "enabled"}
                activeCategory={activeCategory}
                activeServiceKind={activeServiceKind}
                onServiceKindChange={setActiveServiceKind}
                disabledConfigured={connections.length === 0}
                displayMode={effectiveProviderDisplayMode}
                modelSearchQuery={modelSearchQuery}
                onBatchTest={handleBatchTest}
                onCategoryChange={(category, freeOnly) => {
                  setShowFreeOnly(freeOnly);
                  setActiveCategory(freeOnly ? null : category);
                }}
                onDisplayModeChange={setProviderDisplayMode}
                onNewProvider={() => router.push("/proxy/providers/new")}
                onImportFromFile={() => setShowImportFromFileModal(true)}
                searchQuery={searchQuery}
                setModelSearchQuery={setModelSearchQuery}
                setSearchQuery={setSearchQuery}
                showFreeOnly={showFreeOnly}
                summaryStats={summaryStats}
                t={t}
                tc={tc}
                testingMode={testingMode}
              />

              {/* Expiration Banner */}
              {expirations?.summary &&
                (expirations.summary.expired > 0 || expirations.summary.expiringSoon > 0) && (
                  <div
                    className={`p-4 rounded-xl flex items-start gap-3 border ${
                      expirations.summary.expired > 0
                        ? "bg-feedback-danger-surface border-feedback-danger-border"
                        : "bg-feedback-warning-surface border-feedback-warning-border"
                    }`}
                  >
                    <span
                      className={`material-symbols-outlined text-[24px] ${
                        expirations.summary.expired > 0
                          ? "text-feedback-danger-foreground"
                          : "text-feedback-warning-foreground"
                      }`}
                    >
                      {expirations.summary.expired > 0 ? "error" : "warning"}
                    </span>
                    <div className="flex-1">
                      <h3
                        className={`font-semibold ${expirations.summary.expired > 0 ? "text-feedback-danger-foreground" : "text-feedback-warning-foreground"}`}
                      >
                        {expirations.summary.expired > 0
                          ? t("expirationBannerExpired", { count: expirations.summary.expired })
                          : t("expirationBannerExpiringSoon", {
                              count: expirations.summary.expiringSoon,
                            })}
                      </h3>
                      <p className="text-sm mt-1 opacity-80 text-text-main">
                        {expirations.summary.expired > 0
                          ? t("expirationBannerExpiredDesc")
                          : t("expirationBannerExpiringSoonDesc")}
                      </p>
                    </div>
                  </div>
                )}

              {providerView === "all" ? (
                <div className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <p
                      className="flex-1 text-sm text-text-muted"
                      data-testid="provider-catalogue-hint"
                    >
                      {providerText(
                        t,
                        "catalogueHint",
                        "Everything RedRouter can route to. Adding a provider opens its page, where you connect it."
                      )}
                    </p>
                    {ccCompatibleProviderEnabled && (
                      <Button
                        size="sm"
                        icon="add"
                        onClick={() => setShowAddCcCompatibleModal(true)}
                      >
                        {addCcCompatibleLabel}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      icon="add"
                      onClick={() => setShowAddAnthropicCompatibleModal(true)}
                    >
                      {t("addAnthropicCompatible")}
                    </Button>
                    <Button size="sm" icon="add" onClick={() => setShowAddCompatibleModal(true)}>
                      {t("addOpenAICompatible")}
                    </Button>
                  </div>
                  <ProviderCatalogueList
                    entries={catalogueEntries as any}
                    availability={providerAvailability}
                    onOpenProvider={(id) => router.push(`/proxy/providers/${id}`)}
                  />
                </div>
              ) : isCompactProviderDisplay ? (
                compactProviderEntries.length > 0 ? (
                  <div
                    className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-3"
                    data-testid="provider-compact-grid"
                  >
                    {compactProviderEntries.map((entry) => (
                      <HighlightableProviderCard
                        key={`compact-${entry.providerId}`}
                        providerId={entry.providerId}
                        provider={entry.provider}
                        stats={entry.stats}
                        authType={getCompactProviderAuthType(entry, showFreeOnly)}
                        showAuthTypeTag
                        onToggle={(active) =>
                          handleToggleProvider(entry.providerId, entry.toggleAuthType, active)
                        }
                      />
                    ))}
                  </div>
                ) : (
                  <div
                    className="flex items-center justify-center gap-2 py-8 border border-dashed border-border rounded-xl text-text-muted text-sm"
                    data-testid="provider-compact-empty"
                  >
                    <Icon icon={SearchX} size="md" color="current" />
                    <span>
                      {providerText(t, "noProvidersMatch", "No providers match your search.")}
                    </span>
                  </div>
                )
              ) : (
                <>
                  {/* API Key Compatible Providers — dynamic (OpenAI/Anthropic compatible) */}
                  {showSection("compatible") && compatibleProviderEntries.length > 0 && (
                    <div className="flex flex-col gap-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-xl font-semibold flex items-center gap-2 flex-1 min-w-0">
                          {t("compatibleProviders")}{" "}
                          <ProviderCountBadge {...countConfigured(compatibleProviderEntriesAll)} />
                        </h2>
                        <div className="flex flex-wrap gap-2">
                          {(compatibleProviders.length > 0 ||
                            anthropicCompatibleProviders.length > 0 ||
                            ccCompatibleProviders.length > 0) && (
                            <button
                              onClick={() => handleBatchTest("compatible")}
                              disabled={!!testingMode}
                              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                                testingMode === "compatible"
                                  ? "bg-primary/20 border-primary/40 text-primary animate-pulse"
                                  : "bg-bg-subtle border-border text-text-muted hover:text-text-primary hover:border-primary/40"
                              }`}
                              title={t("testAllCompatible")}
                            >
                              <span
                                className={`material-symbols-outlined text-[14px]${testingMode === "compatible" ? " animate-spin" : ""}`}
                              >
                                play_arrow
                              </span>
                              {testingMode === "compatible" ? t("testing") : t("testAll")}
                            </button>
                          )}
                          {ccCompatibleProviderEnabled && (
                            <Button
                              size="sm"
                              icon="add"
                              onClick={() => setShowAddCcCompatibleModal(true)}
                            >
                              {addCcCompatibleLabel}
                            </Button>
                          )}
                          <Button
                            size="sm"
                            icon="add"
                            onClick={() => setShowAddAnthropicCompatibleModal(true)}
                          >
                            {t("addAnthropicCompatible")}
                          </Button>
                          <Button
                            size="sm"
                            icon="add"
                            onClick={() => setShowAddCompatibleModal(true)}
                          >
                            {t("addOpenAICompatible")}
                          </Button>
                        </div>
                      </div>
                      <p className="text-sm text-text-muted -mt-2">
                        {t("compatibleProvidersDesc")}
                      </p>
                      {compatibleProviders.length === 0 &&
                      anthropicCompatibleProviders.length === 0 &&
                      ccCompatibleProviders.length === 0 ? (
                        <div className="flex items-center justify-center gap-2 py-2 border border-dashed border-border rounded-xl text-text-muted text-sm">
                          <Icon icon={Puzzle} size="md" color="current" />
                          <span>{t("noCompatibleYet")}</span>
                        </div>
                      ) : (
                        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-3">
                          {compatibleProviderEntries.map(
                            ({ providerId, provider, stats, displayAuthType, toggleAuthType }) => (
                              <HighlightableProviderCard
                                key={providerId}
                                providerId={providerId}
                                provider={provider}
                                stats={stats}
                                authType={displayAuthType}
                                onToggle={(active) =>
                                  handleToggleProvider(providerId, toggleAuthType, active)
                                }
                              />
                            )
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* OAuth Providers (including providers that expose free tiers via OAuth) */}
                  {showSection("oauth") &&
                    oauthProviderEntries.some((e) => !IDE_PROVIDER_IDS.has(e.providerId)) && (
                      <div className="flex flex-col gap-4">
                        <div className="flex flex-wrap items-center gap-2">
                          <h2 className="text-xl font-semibold flex items-center gap-2 flex-1 min-w-0">
                            {t("oauthProviders")}{" "}
                            <ProviderCountBadge
                              {...countConfigured(
                                oauthProviderEntriesAll.filter(
                                  (e) => !IDE_PROVIDER_IDS.has(e.providerId)
                                )
                              )}
                            />
                          </h2>
                          <div className="flex items-center gap-2">
                            {oauthEnvRepairStatus?.available &&
                              oauthEnvRepairStatus.missingCount > 0 && (
                                <button
                                  onClick={handleRepairEnv}
                                  disabled={repairingEnv}
                                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                                    repairingEnv
                                      ? "bg-primary/20 border-primary/40 text-primary animate-pulse"
                                      : "bg-bg-subtle border-border text-text-muted hover:text-text-primary hover:border-primary/40"
                                  }`}
                                  title={t("repairEnvHint")}
                                  aria-label={t("repairEnv")}
                                >
                                  <span className="material-symbols-outlined text-[14px]">
                                    {repairingEnv ? "sync" : "settings_backup_restore"}
                                  </span>
                                  {repairingEnv ? t("repairEnvWorking") : t("repairEnv")}
                                </button>
                              )}
                            <button
                              onClick={() => handleBatchTest("oauth")}
                              disabled={!!testingMode}
                              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                                testingMode === "oauth"
                                  ? "bg-primary/20 border-primary/40 text-primary animate-pulse"
                                  : "bg-bg-subtle border-border text-text-muted hover:text-text-primary hover:border-primary/40"
                              }`}
                              title={t("testAllOAuth")}
                              aria-label={t("testAllOAuth")}
                            >
                              <span
                                className={`material-symbols-outlined text-[14px]${testingMode === "oauth" ? " animate-spin" : ""}`}
                              >
                                play_arrow
                              </span>
                              {testingMode === "oauth" ? t("testing") : t("testAll")}
                            </button>
                          </div>
                        </div>
                        <p className="text-sm text-text-muted -mt-2">{t("oauthProvidersDesc")}</p>
                        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-3">
                          {oauthProviderEntries
                            .filter((e) => !IDE_PROVIDER_IDS.has(e.providerId))
                            .map(
                              ({
                                providerId,
                                provider,
                                stats,
                                displayAuthType,
                                toggleAuthType,
                              }) => (
                                <HighlightableProviderCard
                                  key={providerId}
                                  providerId={providerId}
                                  provider={provider}
                                  stats={stats}
                                  authType={displayAuthType}
                                  onToggle={(active) =>
                                    handleToggleProvider(providerId, toggleAuthType, active)
                                  }
                                />
                              )
                            )}
                        </div>
                      </div>
                    )}

                  {/* IDE Providers (Cursor, Zed, Trae) — editors with built-in AI subscription */}
                  {showSection("ide") && ideProviderEntries.length > 0 && (
                    <div className="flex flex-col gap-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-xl font-semibold flex items-center gap-2 flex-1 min-w-0">
                          {t("ideProviders") || "IDE Providers"}{" "}
                          <ProviderCountBadge {...countConfigured(ideProviderEntriesAll)} />
                        </h2>
                        <button
                          onClick={() => handleBatchTest("ide")}
                          disabled={!!testingMode}
                          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                            testingMode === "ide"
                              ? "bg-primary/20 border-primary/40 text-primary animate-pulse"
                              : "bg-bg-subtle border-border text-text-muted hover:text-text-primary hover:border-primary/40"
                          }`}
                          title={t("testAll")}
                          aria-label={t("testAll")}
                        >
                          <span
                            className={`material-symbols-outlined text-[14px]${testingMode === "ide" ? " animate-spin" : ""}`}
                          >
                            play_arrow
                          </span>
                          {testingMode === "ide" ? t("testing") : t("testAll")}
                        </button>
                      </div>
                      <p className="text-sm text-text-muted -mt-2">
                        {t("ideProvidersDesc") ||
                          "Editors with built-in AI subscription. Use the provider page to import credentials directly from the IDE's keychain."}
                      </p>
                      {ideProviderEntries.length === 0 ? (
                        <div className="rounded-lg border border-dashed border-border bg-bg-subtle p-6 text-center text-sm text-text-muted">
                          {t("noIdeProviders") || "No IDE providers match the current filters."}
                        </div>
                      ) : (
                        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-3">
                          {ideProviderEntries.map(
                            ({ providerId, provider, stats, displayAuthType, toggleAuthType }) => (
                              <HighlightableProviderCard
                                key={`ide-${providerId}`}
                                providerId={providerId}
                                provider={provider}
                                stats={stats}
                                authType={displayAuthType}
                                onToggle={(active) =>
                                  handleToggleProvider(providerId, toggleAuthType, active)
                                }
                              />
                            )
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Web / Cookie Providers */}
                  {showSection("web") && webCookieProviderEntries.length > 0 && (
                    <div className="flex flex-col gap-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-xl font-semibold flex items-center gap-2 flex-1 min-w-0">
                          {t("webCookieProviders")}{" "}
                          <ProviderCountBadge {...countConfigured(webCookieProviderEntriesAll)} />
                        </h2>
                        <button
                          onClick={() => handleBatchTest("web-cookie")}
                          disabled={!!testingMode}
                          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                            testingMode === "web-cookie"
                              ? "bg-primary/20 border-primary/40 text-primary animate-pulse"
                              : "bg-bg-subtle border-border text-text-muted hover:text-text-primary hover:border-primary/40"
                          }`}
                          title={t("testAll")}
                        >
                          <span
                            className={`material-symbols-outlined text-[14px]${testingMode === "web-cookie" ? " animate-spin" : ""}`}
                          >
                            play_arrow
                          </span>
                          {testingMode === "web-cookie" ? t("testing") : t("testAll")}
                        </button>
                      </div>
                      <p className="text-sm text-text-muted -mt-2">{t("webCookieProvidersDesc")}</p>
                      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-3">
                        {webCookieProviderEntries.map(
                          ({ providerId, provider, stats, toggleAuthType }) => (
                            <HighlightableProviderCard
                              key={providerId}
                              providerId={providerId}
                              provider={provider}
                              stats={stats}
                              authType="web-cookie"
                              onToggle={(active) =>
                                handleToggleProvider(providerId, toggleAuthType, active)
                              }
                            />
                          )
                        )}
                      </div>
                    </div>
                  )}

                  {/* Free Tier Providers */}
                  {showSection("free") && freeSectionEntries.length > 0 && (
                    <div className="flex flex-col gap-4">
                      <div className="flex flex-wrap items-start gap-2">
                        <div className="flex-1 min-w-0">
                          <h2 className="text-xl font-semibold flex items-center gap-2">
                            {t("freeTierProviders")}
                            <ProviderCountBadge {...countConfigured(freeSectionEntriesAll)} />
                          </h2>
                          <p className="text-sm text-text-muted mt-1">{t("freeAggregated")}</p>
                        </div>
                        <button
                          onClick={() => handleBatchTest("free")}
                          disabled={!!testingMode}
                          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                            testingMode === "free"
                              ? "bg-primary/20 border-primary/40 text-primary animate-pulse"
                              : "bg-bg-subtle border-border text-text-muted hover:text-text-primary hover:border-primary/40"
                          }`}
                          title={t("testAll")}
                        >
                          <span
                            className={`material-symbols-outlined text-[14px]${testingMode === "free" ? " animate-spin" : ""}`}
                          >
                            play_arrow
                          </span>
                          {testingMode === "free" ? t("testing") : t("testAll")}
                        </button>
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-3">
                        {freeSectionEntries.map(
                          ({ providerId, provider, stats, displayAuthType, toggleAuthType }) => (
                            <HighlightableProviderCard
                              key={`free-section-${providerId}`}
                              providerId={providerId}
                              provider={provider}
                              stats={stats}
                              authType={toggleAuthType === "free" ? "free" : displayAuthType}
                              onToggle={(active) =>
                                handleToggleProvider(providerId, toggleAuthType, active)
                              }
                            />
                          )
                        )}
                      </div>
                    </div>
                  )}

                  {/* API Key Providers — fixed list */}
                  {showSection("apikey") && llmProviderEntries.length > 0 && (
                    <div className="flex flex-col gap-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-xl font-semibold flex items-center gap-2 flex-1 min-w-0">
                          {t("apiKeyProviders")}{" "}
                          <ProviderCountBadge {...countConfigured(apiKeyProviderEntriesAll)} />
                        </h2>
                        <button
                          onClick={() => handleBatchTest("apikey")}
                          disabled={!!testingMode}
                          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                            testingMode === "apikey"
                              ? "bg-primary/20 border-primary/40 text-primary animate-pulse"
                              : "bg-bg-subtle border-border text-text-muted hover:text-text-primary hover:border-primary/40"
                          }`}
                          title={t("testAllApiKey")}
                          aria-label={t("testAllApiKey")}
                        >
                          <span
                            className={`material-symbols-outlined text-[14px]${testingMode === "apikey" ? " animate-spin" : ""}`}
                          >
                            play_arrow
                          </span>
                          {testingMode === "apikey" ? t("testing") : t("testAll")}
                        </button>
                      </div>
                      <p className="text-sm text-text-muted -mt-2">{t("apiKeyProvidersDesc")}</p>
                      {llmProviderEntries.length > 0 && (
                        <div className="flex flex-col gap-3">
                          <h3 className="text-xs font-semibold uppercase tracking-wider text-text-muted">
                            {t("llmProviders")}
                          </h3>
                          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-3">
                            {llmProviderEntries.map(
                              ({
                                providerId,
                                provider,
                                stats,
                                displayAuthType,
                                toggleAuthType,
                              }) => (
                                <HighlightableProviderCard
                                  key={providerId}
                                  providerId={providerId}
                                  provider={provider}
                                  stats={stats}
                                  authType={displayAuthType}
                                  onToggle={(active) =>
                                    handleToggleProvider(providerId, toggleAuthType, active)
                                  }
                                />
                              )
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* No Auth Providers */}
                  {showSection("noauth") &&
                    !showFreeOnly &&
                    (noAuthEntries.length > 0 || blockedNoAuthShown.length > 0) && (
                      <NoAuthProvidersSection
                        visibleEntries={noAuthEntries}
                        count={countConfigured(noAuthEntriesAll)}
                        blockedEntries={blockedNoAuthShown}
                        blockedProviders={blockedProviders}
                        onBlockedChange={setBlockedProviders}
                        onError={(msg) => notify.error(msg)}
                        testingMode={testingMode}
                        onBatchTest={handleBatchTest}
                        onToggleProvider={handleToggleProvider}
                      />
                    )}

                  {/* Upstream Proxy Providers */}
                  {showSection("proxy") && upstreamProxyEntries.length > 0 && (
                    <div className="flex flex-col gap-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-xl font-semibold flex items-center gap-2 flex-1 min-w-0">
                          {t("upstreamProxyProviders")}{" "}
                          <ProviderCountBadge {...countConfigured(upstreamProxyEntriesAll)} />
                        </h2>
                        <button
                          onClick={() => handleBatchTest("upstream-proxy")}
                          disabled={!!testingMode}
                          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                            testingMode === "upstream-proxy"
                              ? "bg-primary/20 border-primary/40 text-primary animate-pulse"
                              : "bg-bg-subtle border-border text-text-muted hover:text-text-primary hover:border-primary/40"
                          }`}
                          title={t("testAll")}
                        >
                          <span
                            className={`material-symbols-outlined text-[14px]${testingMode === "upstream-proxy" ? " animate-spin" : ""}`}
                          >
                            play_arrow
                          </span>
                          {testingMode === "upstream-proxy" ? t("testing") : t("testAll")}
                        </button>
                      </div>
                      <p className="text-sm text-text-muted -mt-2">
                        {t("upstreamProxyProvidersDesc")}
                      </p>
                      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-3">
                        {upstreamProxyEntries.map(
                          ({ providerId, provider, stats, toggleAuthType }) => (
                            <HighlightableProviderCard
                              key={providerId}
                              providerId={providerId}
                              provider={provider}
                              stats={stats}
                              authType="upstream-proxy"
                              onToggle={(active) =>
                                handleToggleProvider(providerId, toggleAuthType, active)
                              }
                            />
                          )
                        )}
                      </div>
                    </div>
                  )}

                  {/* Web Fetch Providers */}
                  {showSection("webfetch") && webFetchEntries.length > 0 && (
                    <div className="flex flex-col gap-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-xl font-semibold flex items-center gap-2 flex-1 min-w-0">
                          {t("webFetchProvidersHeading")}{" "}
                          <ProviderCountBadge {...countConfigured(webFetchEntriesAll)} />
                        </h2>
                      </div>
                      <p className="text-sm text-text-muted -mt-2">{t("webFetchProvidersDesc")}</p>
                      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-3">
                        {webFetchEntries.map(
                          ({ providerId, provider, stats, displayAuthType, toggleAuthType }) => (
                            <HighlightableProviderCard
                              key={`webfetch-${providerId}`}
                              providerId={providerId}
                              provider={provider}
                              stats={stats}
                              authType={displayAuthType}
                              onToggle={(active) =>
                                handleToggleProvider(providerId, toggleAuthType, active)
                              }
                            />
                          )
                        )}
                      </div>
                    </div>
                  )}

                  {/* Aggregators Gateways */}
                  {showSection("apikey") && aggregatorProviderEntries.length > 0 && (
                    <div className="flex flex-col gap-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-xl font-semibold flex items-center gap-2 flex-1 min-w-0">
                          {t("aggregatorsGateways")}{" "}
                          <ProviderCountBadge {...countConfigured(aggregatorProviderEntriesAll)} />
                        </h2>
                      </div>
                      <p className="text-sm text-text-muted -mt-2">
                        {t("aggregatorsGatewaysDesc")}
                      </p>
                      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-3">
                        {aggregatorProviderEntries.map(
                          ({ providerId, provider, stats, displayAuthType, toggleAuthType }) => (
                            <HighlightableProviderCard
                              key={providerId}
                              providerId={providerId}
                              provider={provider}
                              stats={stats}
                              authType={displayAuthType}
                              onToggle={(active) =>
                                handleToggleProvider(providerId, toggleAuthType, active)
                              }
                            />
                          )
                        )}
                      </div>
                    </div>
                  )}

                  {/* Enterprise & Cloud */}
                  {showSection("apikey") && enterpriseProviderEntries.length > 0 && (
                    <div className="flex flex-col gap-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-xl font-semibold flex items-center gap-2 flex-1 min-w-0">
                          {t("enterpriseCloud")}{" "}
                          <ProviderCountBadge {...countConfigured(enterpriseProviderEntriesAll)} />
                        </h2>
                      </div>
                      <p className="text-sm text-text-muted -mt-2">{t("enterpriseCloudDesc")}</p>
                      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-3">
                        {enterpriseProviderEntries.map(
                          ({ providerId, provider, stats, displayAuthType, toggleAuthType }) => (
                            <HighlightableProviderCard
                              key={providerId}
                              providerId={providerId}
                              provider={provider}
                              stats={stats}
                              authType={displayAuthType}
                              onToggle={(active) =>
                                handleToggleProvider(providerId, toggleAuthType, active)
                              }
                            />
                          )
                        )}
                      </div>
                    </div>
                  )}

                  {/* Cloud Agent Providers */}
                  {showSection("cloud") && cloudAgentProviderEntries.length > 0 && (
                    <div className="flex flex-col gap-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-xl font-semibold flex items-center gap-2 flex-1 min-w-0">
                          {t("cloudAgentProviders")}{" "}
                          <ProviderCountBadge {...countConfigured(cloudAgentProviderEntriesAll)} />
                        </h2>
                        <button
                          onClick={() => handleBatchTest("cloud-agent")}
                          disabled={!!testingMode}
                          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                            testingMode === "cloud-agent"
                              ? "bg-primary/20 border-primary/40 text-primary animate-pulse"
                              : "bg-bg-subtle border-border text-text-muted hover:text-text-primary hover:border-primary/40"
                          }`}
                          title={t("testAll")}
                        >
                          <span
                            className={`material-symbols-outlined text-[14px]${testingMode === "cloud-agent" ? " animate-spin" : ""}`}
                          >
                            play_arrow
                          </span>
                          {testingMode === "cloud-agent" ? t("testing") : t("testAll")}
                        </button>
                      </div>
                      <p className="text-sm text-text-muted -mt-2">
                        {t("cloudAgentProvidersDesc")}
                      </p>
                      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-3">
                        {cloudAgentProviderEntries.map(
                          ({ providerId, provider, stats, toggleAuthType }) => (
                            <HighlightableProviderCard
                              key={providerId}
                              providerId={providerId}
                              provider={provider}
                              stats={stats}
                              authType="cloud-agent"
                              onToggle={(active) =>
                                handleToggleProvider(providerId, toggleAuthType, active)
                              }
                            />
                          )
                        )}
                      </div>
                    </div>
                  )}

                  {/* Local / Self-Hosted Providers */}
                  {showSection("local") && localProviderEntries.length > 0 && (
                    <div className="flex flex-col gap-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-xl font-semibold flex items-center gap-2 flex-1 min-w-0">
                          {t("localProviders")}{" "}
                          <ProviderCountBadge {...countConfigured(localProviderEntriesAll)} />
                        </h2>
                        <button
                          onClick={() => handleBatchTest("local")}
                          disabled={!!testingMode}
                          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                            testingMode === "local"
                              ? "bg-primary/20 border-primary/40 text-primary animate-pulse"
                              : "bg-bg-subtle border-border text-text-muted hover:text-text-primary hover:border-primary/40"
                          }`}
                          title={t("testAll")}
                        >
                          <span
                            className={`material-symbols-outlined text-[14px]${testingMode === "local" ? " animate-spin" : ""}`}
                          >
                            play_arrow
                          </span>
                          {testingMode === "local" ? t("testing") : t("testAll")}
                        </button>
                      </div>
                      <p className="text-sm text-text-muted -mt-2">{t("localProvidersDesc")}</p>
                      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-3">
                        {localProviderEntries.map(
                          ({ providerId, provider, stats, toggleAuthType }) => (
                            <HighlightableProviderCard
                              key={providerId}
                              providerId={providerId}
                              provider={provider}
                              stats={stats}
                              authType="local"
                              onToggle={(active) =>
                                handleToggleProvider(providerId, toggleAuthType, active)
                              }
                            />
                          )
                        )}
                      </div>
                    </div>
                  )}

                  {/* Search Providers */}
                  {showSection("search") && searchProviderEntries.length > 0 && (
                    <div className="flex flex-col gap-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-xl font-semibold flex items-center gap-2 flex-1 min-w-0">
                          {t("searchProvidersHeading")}{" "}
                          <ProviderCountBadge {...countConfigured(searchProviderEntriesAll)} />
                        </h2>
                        <button
                          onClick={() => handleBatchTest("search")}
                          disabled={!!testingMode}
                          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                            testingMode === "search"
                              ? "bg-primary/20 border-primary/40 text-primary animate-pulse"
                              : "bg-bg-subtle border-border text-text-muted hover:text-text-primary hover:border-primary/40"
                          }`}
                          title={t("testAll")}
                        >
                          <span
                            className={`material-symbols-outlined text-[14px]${testingMode === "search" ? " animate-spin" : ""}`}
                          >
                            play_arrow
                          </span>
                          {testingMode === "search" ? t("testing") : t("testAll")}
                        </button>
                      </div>
                      <p className="text-sm text-text-muted -mt-2">{t("searchProvidersDesc")}</p>
                      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-3">
                        {searchProviderEntries.map(
                          ({ providerId, provider, stats, toggleAuthType }) => (
                            <HighlightableProviderCard
                              key={providerId}
                              providerId={providerId}
                              provider={provider}
                              stats={stats}
                              authType="search"
                              onToggle={(active) =>
                                handleToggleProvider(providerId, toggleAuthType, active)
                              }
                            />
                          )
                        )}
                      </div>
                    </div>
                  )}

                  {/* Embeddings & Rerank */}
                  {showSection("apikey") && embeddingRerankProviderEntries.length > 0 && (
                    <div className="flex flex-col gap-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-xl font-semibold flex items-center gap-2 flex-1 min-w-0">
                          {t("embeddingRerankProviders")}{" "}
                          <ProviderCountBadge
                            {...countConfigured(embeddingRerankProviderEntriesAll)}
                          />
                        </h2>
                      </div>
                      <p className="text-sm text-text-muted -mt-2">
                        {t("embeddingRerankProvidersDesc")}
                      </p>
                      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-3">
                        {embeddingRerankProviderEntries.map(
                          ({ providerId, provider, stats, displayAuthType, toggleAuthType }) => (
                            <HighlightableProviderCard
                              key={providerId}
                              providerId={providerId}
                              provider={provider}
                              stats={stats}
                              authType={displayAuthType}
                              onToggle={(active) =>
                                handleToggleProvider(providerId, toggleAuthType, active)
                              }
                            />
                          )
                        )}
                      </div>
                    </div>
                  )}

                  {/* Image Providers */}
                  {showSection("apikey") && imageProviderEntries.length > 0 && (
                    <div className="flex flex-col gap-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-xl font-semibold flex items-center gap-2 flex-1 min-w-0">
                          {t("imageProviders")}{" "}
                          <ProviderCountBadge {...countConfigured(imageProviderEntriesAll)} />
                        </h2>
                      </div>
                      <p className="text-sm text-text-muted -mt-2">{t("imageProvidersDesc")}</p>
                      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-3">
                        {imageProviderEntries.map(
                          ({ providerId, provider, stats, displayAuthType, toggleAuthType }) => (
                            <HighlightableProviderCard
                              key={providerId}
                              providerId={providerId}
                              provider={provider}
                              stats={stats}
                              authType={displayAuthType}
                              onToggle={(active) =>
                                handleToggleProvider(providerId, toggleAuthType, active)
                              }
                            />
                          )
                        )}
                      </div>
                    </div>
                  )}

                  {/* Audio Only Providers */}
                  {showSection("audio") && audioProviderEntries.length > 0 && (
                    <div className="flex flex-col gap-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-xl font-semibold flex items-center gap-2 flex-1 min-w-0">
                          {t("audioProvidersHeading")}{" "}
                          <ProviderCountBadge {...countConfigured(audioProviderEntriesAll)} />
                        </h2>
                        <button
                          onClick={() => handleBatchTest("audio")}
                          disabled={!!testingMode}
                          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                            testingMode === "audio"
                              ? "bg-primary/20 border-primary/40 text-primary animate-pulse"
                              : "bg-bg-subtle border-border text-text-muted hover:text-text-primary hover:border-primary/40"
                          }`}
                          title={t("testAll")}
                        >
                          <span
                            className={`material-symbols-outlined text-[14px]${testingMode === "audio" ? " animate-spin" : ""}`}
                          >
                            play_arrow
                          </span>
                          {testingMode === "audio" ? t("testing") : t("testAll")}
                        </button>
                      </div>
                      <p className="text-sm text-text-muted -mt-2">{t("audioProvidersDesc")}</p>
                      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-3">
                        {audioProviderEntries.map(
                          ({ providerId, provider, stats, toggleAuthType }) => (
                            <HighlightableProviderCard
                              key={providerId}
                              providerId={providerId}
                              provider={provider}
                              stats={stats}
                              authType="audio"
                              onToggle={(active) =>
                                handleToggleProvider(providerId, toggleAuthType, active)
                              }
                            />
                          )
                        )}
                      </div>
                    </div>
                  )}

                  {/* Video Generation */}
                  {showSection("apikey") && videoProviderEntries.length > 0 && (
                    <div className="flex flex-col gap-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-xl font-semibold flex items-center gap-2 flex-1 min-w-0">
                          {t("videoProviders")}{" "}
                          <ProviderCountBadge {...countConfigured(videoProviderEntriesAll)} />
                        </h2>
                      </div>
                      <p className="text-sm text-text-muted -mt-2">{t("videoProvidersDesc")}</p>
                      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-3">
                        {videoProviderEntries.map(
                          ({ providerId, provider, stats, displayAuthType, toggleAuthType }) => (
                            <HighlightableProviderCard
                              key={providerId}
                              providerId={providerId}
                              provider={provider}
                              stats={stats}
                              authType={displayAuthType}
                              onToggle={(active) =>
                                handleToggleProvider(providerId, toggleAuthType, active)
                              }
                            />
                          )
                        )}
                      </div>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>

        <AddCompatibleProviderModal
          isOpen={showAddCompatibleModal}
          mode="openai"
          onClose={() => setShowAddCompatibleModal(false)}
          onCreated={(node) => {
            setProviderNodes((prev) => upsertProviderNodeById(prev, node));
            setShowAddCompatibleModal(false);
            router.push(`/proxy/providers/${node.id}`);
          }}
        />
        <AddCompatibleProviderModal
          isOpen={showAddAnthropicCompatibleModal}
          mode="anthropic"
          onClose={() => setShowAddAnthropicCompatibleModal(false)}
          onCreated={(node) => {
            setProviderNodes((prev) => upsertProviderNodeById(prev, node));
            setShowAddAnthropicCompatibleModal(false);
            router.push(`/proxy/providers/${node.id}`);
          }}
        />
        {ccCompatibleProviderEnabled && (
          <AddCompatibleProviderModal
            isOpen={showAddCcCompatibleModal}
            mode="cc"
            title={addCcCompatibleLabel}
            onClose={() => setShowAddCcCompatibleModal(false)}
            onCreated={(node) => {
              setProviderNodes((prev) => upsertProviderNodeById(prev, node));
              setShowAddCcCompatibleModal(false);
              router.push(`/proxy/providers/${node.id}`);
            }}
          />
        )}
        <ImportProvidersFromFileModal
          isOpen={showImportFromFileModal}
          onClose={() => setShowImportFromFileModal(false)}
          onImported={async () => setConnections((await loadProviderPageData()).connections)}
        />
        {/* Test Results Modal */}
        {testResults && (
          <div
            className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]"
            onClick={() => setTestResults(null)}
          >
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
            <div
              className="relative bg-bg-primary border border-border rounded-xl w-full max-w-[600px] max-h-[80vh] overflow-y-auto shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="sticky top-0 z-10 flex items-center justify-between px-5 py-3 border-b border-border bg-bg-primary/95 backdrop-blur-sm rounded-t-xl">
                <h3 className="font-semibold">{t("testResults")}</h3>
                <button
                  onClick={() => setTestResults(null)}
                  className="p-1 rounded-lg hover:bg-bg-subtle text-text-muted hover:text-text-primary transition-colors"
                  aria-label={tc("close")}
                >
                  <Icon icon={X} size="md" color="current" />
                </button>
              </div>
              <div className="p-5">
                <ProviderTestResultsView results={testResults} />
              </div>
            </div>
          </div>
        )}
      </div>
    </OpenRouterProviderStatsProvider>
  );
}

export default function ProvidersPage() {
  return (
    <Suspense fallback={null}>
      <ProvidersPageContent />
    </Suspense>
  );
}

// ─── Provider Test Results View (mirrors combo TestResultsView) ──────────────

function ProviderTestResultsView({ results }: { results: ProviderBatchTestResults }) {
  const t = useTranslations("providers");
  const tc = useTranslations("common");
  const emailsVisible = useEmailPrivacyStore((s) => s.emailsVisible);

  // Guard: never crash on malformed/null results (would trigger error boundary)
  if (!results || typeof results !== "object") {
    return null;
  }

  if (results.error && (!results.results || results.results.length === 0)) {
    return (
      <div className="text-center py-6">
        <Icon
          icon={CircleAlert}
          size="lg"
          color="feedback-danger-foreground"
          className="mb-2 block"
          style={{ width: 32, height: 32 }}
        />
        <p className="text-sm text-feedback-danger-foreground">
          {typeof results.error === "object"
            ? results.error?.message || JSON.stringify(results.error)
            : String(results.error)}
        </p>
      </div>
    );
  }

  const summary = results.summary ?? null;
  const mode = results.mode ?? "";
  const items = Array.isArray(results.results) ? results.results : [];

  const modeLabel =
    {
      oauth: t("oauthLabel"),
      free: tc("free"),
      apikey: t("apiKeyLabel"),
      compatible: t("compatibleLabel"),
      provider: t("providerLabel"),
      all: tc("all"),
    }[mode] || mode;

  return (
    <div className="flex flex-col gap-3">
      {/* Summary header */}
      {summary && (
        <div className="flex items-center gap-3 text-xs mb-1">
          <span className="text-text-muted">{t("modeTest", { mode: modeLabel })}</span>
          <span className="px-2 py-0.5 rounded bg-feedback-success-surface text-feedback-success-foreground font-medium">
            {t("passedCount", { count: summary.passed })}
          </span>
          {summary.failed > 0 && (
            <span className="px-2 py-0.5 rounded bg-feedback-danger-surface text-feedback-danger-foreground font-medium">
              {t("failedCount", { count: summary.failed })}
            </span>
          )}
          <span className="text-text-muted ml-auto">
            {t("testedCount", { count: summary.total })}
          </span>
        </div>
      )}

      {/* Individual results */}
      {items.map((r, i) => (
        <div
          key={r.connectionId || i}
          className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg bg-black/[0.03] dark:bg-white/[0.03]"
        >
          <span
            className={`material-symbols-outlined text-[16px] ${
              r.valid ? "text-feedback-success-foreground" : "text-feedback-danger-foreground"
            }`}
          >
            {r.valid ? "check_circle" : "error"}
          </span>
          <div className="flex-1 min-w-0">
            <span className="font-medium">
              {pickDisplayValue([r.connectionName], emailsVisible, r.connectionName)}
            </span>
            <span className="text-text-muted ml-1.5">({r.provider})</span>
          </div>
          {r.latencyMs !== undefined && (
            <span className="text-text-muted font-mono tabular-nums">
              {t("millisecondsAbbr", { value: r.latencyMs })}
            </span>
          )}
          <span
            className={`text-[10px] uppercase font-bold px-1.5 py-0.5 rounded ${
              r.valid
                ? "bg-feedback-success-surface text-feedback-success-foreground"
                : "bg-feedback-danger-surface text-feedback-danger-foreground"
            }`}
          >
            {r.valid ? t("okShort") : r.diagnosis?.type || t("errorShort")}
          </span>
        </div>
      ))}

      {items.length === 0 && (
        <div className="text-center py-4 text-text-muted text-sm">
          {t("noActiveConnectionsInGroup")}
        </div>
      )}
    </div>
  );
}
