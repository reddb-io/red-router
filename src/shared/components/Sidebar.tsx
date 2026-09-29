"use client";

import { useState, useEffect, useCallback, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { filterSidebarSectionsByQuery } from "@/shared/utils/sidebarSearch";
import { APP_CONFIG } from "@/shared/constants/appConfig";
import { displayInstanceName } from "@/shared/constants/productBranding";
import { useBranding } from "@/shared/components/BrandingProvider";
import Button from "./Button";
import Icon from "./Icon";
import { ConfirmModal } from "./Modal";
import CloudSyncStatus from "./CloudSyncStatus";
import SidebarRail, { type RailAction } from "./shell/SidebarRail";
import SidebarPanel, { type PanelBlock, type PanelItem } from "./shell/SidebarPanel";
import { useTranslations } from "next-intl";
import {
  HIDDEN_SIDEBAR_ITEMS_SETTING_KEY,
  SIDEBAR_SETTINGS_UPDATED_EVENT,
  normalizeHiddenSidebarItems,
} from "@/shared/constants/sidebarVisibility";
import {
  findNavMatch,
  resolveNavSections,
  type ResolvedNavEntry,
  type ResolvedNavSection,
  type SidebarNavTab,
} from "@/shared/constants/sidebarNav";
import { navIcon } from "@/shared/icons/navIcons";
import { parseRadarAdminUrl } from "@/shared/validation/radarAdminUrl";

const isE2EMode = process.env.NEXT_PUBLIC_OMNIROUTE_E2E_MODE === "1";
const PINNED_ITEMS_KEY = "sidebar-pinned-items";

type SidebarProps = {
  /** Closes the mobile drawer after a navigation. */
  onClose?: () => void;
  /** Whether the panel next to the rail is shown; the drawer always shows it. */
  panelOpen?: boolean;
  onPanelOpenChange?: (open: boolean) => void;
  onOpenCommandPalette?: () => void;
  isMacElectron?: boolean;
};

function parseStoredArray<T>(raw: string | null, fallback: T): T {
  try {
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as T;
    }
  } catch {}
  return fallback;
}

function saveToStorage(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

// useSyncExternalStore plumbing for the one-shot localStorage hydration read: nothing to
// subscribe to, and the server snapshot is always null so the SSR/hydration render matches.
const noopSubscribe = () => () => {};
const getServerSnapshotNull = () => null;
const getHydratedSnapshot = () => true;
const getServerHydratedSnapshot = () => false;
function readStoredPinnedItemsRaw() {
  try {
    return localStorage.getItem(PINNED_ITEMS_KEY);
  } catch {
    return null;
  }
}

const entryItem = (entry: ResolvedNavEntry): PanelItem => ({
  id: entry.id,
  href: entry.href,
  label: entry.label,
  icon: entry.icon,
  external: entry.external,
  entryId: entry.id,
  group: entry.group,
});

const tabItem = (entry: ResolvedNavEntry, page: SidebarNavTab): PanelItem => ({
  id: page.id ?? page.href,
  href: page.href,
  label: page.label,
  icon: entry.icon,
  external: page.external === true,
  description: `${entry.label} › ${page.label}`,
  entryId: entry.id,
});

export default function Sidebar({
  onClose,
  panelOpen = true,
  onPanelOpenChange,
  onOpenCommandPalette,
  isMacElectron = false,
}: SidebarProps) {
  const pathname = usePathname();
  const t = useTranslations("sidebar");
  const tc = useTranslations("common");
  const [showShutdownModal, setShowShutdownModal] = useState(false);
  const [showRestartModal, setShowRestartModal] = useState(false);
  const [isShuttingDown, setIsShuttingDown] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);
  const [isDisconnected, setIsDisconnected] = useState(false);
  const [hiddenSidebarItems, setHiddenSidebarItems] = useState<string[]>([]);
  // Feature-flag map for flag-gated pages (e.g. "radar" -> RADAR_ENABLED).
  // Fails open so a missing key never hides an unrelated page — only set once
  // /api/settings resolves.
  const [featureFlags, setFeatureFlags] = useState<Record<string, boolean>>({});
  const [radarAdminUrl, setRadarAdminUrl] = useState<unknown>(null);
  const [customAppName, setCustomAppName] = useState<string | null>(null);
  const [customLogo, setCustomLogo] = useState<string | null>(null);
  const [pinnedItems, setPinnedItems] = useState<Set<string>>(new Set());
  const [pinnedLoaded, setPinnedLoaded] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  // The area the operator is browsing on the rail; null follows the current page.
  const [browsedArea, setBrowsedArea] = useState<string | null>(null);
  const [prevPathname, setPrevPathname] = useState(pathname);
  if (pathname !== prevPathname) {
    setPrevPathname(pathname);
    setBrowsedArea(null);
  }

  const brand = useBranding();
  // A branding.json is the white-label source of truth; the dashboard
  // instance-name/logo settings apply when there is no branding file.
  const brandName = brand.custom ? brand.name : displayInstanceName(customAppName);
  const brandLogo = brand.custom ? brand.logo : customLogo;

  // Pinned pages are read once the client has hydrated (render-time adjustment, react.dev
  // "You Might Not Need an Effect") so the stored value applies before paint.
  const hydrated = useSyncExternalStore(
    noopSubscribe,
    getHydratedSnapshot,
    getServerHydratedSnapshot
  );
  const storedPinnedItemsRaw = useSyncExternalStore(
    noopSubscribe,
    readStoredPinnedItemsRaw,
    getServerSnapshotNull
  );
  if (hydrated && !pinnedLoaded) {
    setPinnedItems(new Set(parseStoredArray<string[]>(storedPinnedItemsRaw, [])));
    setPinnedLoaded(true);
  }

  useEffect(() => {
    const applySettings = (data) => {
      setHiddenSidebarItems(normalizeHiddenSidebarItems(data?.[HIDDEN_SIDEBAR_ITEMS_SETTING_KEY]));
      setCustomAppName(data?.instanceName || null);
      setCustomLogo(data?.customLogoBase64 || data?.customLogoUrl || null);
      if (typeof data?.radarEnabled === "boolean") {
        setFeatureFlags((prev) => ({ ...prev, RADAR_ENABLED: data.radarEnabled }));
      }
      setRadarAdminUrl(data?.radarAdminUrl ?? null);
    };

    fetch("/api/settings")
      .then((res) => res.json())
      .then(applySettings)
      .catch(() => {});

    const handleSettingsUpdated = (event: Event) => {
      const detail = (event as CustomEvent<Record<string, unknown>>).detail || {};
      if (HIDDEN_SIDEBAR_ITEMS_SETTING_KEY in detail) {
        setHiddenSidebarItems(
          normalizeHiddenSidebarItems(detail[HIDDEN_SIDEBAR_ITEMS_SETTING_KEY])
        );
      }
      if ("instanceName" in detail) setCustomAppName((detail.instanceName as string) || null);
      if ("customLogoBase64" in detail) {
        setCustomLogo((detail.customLogoBase64 as string) || null);
      } else if ("customLogoUrl" in detail) {
        setCustomLogo((detail.customLogoUrl as string) || null);
      }
    };

    window.addEventListener(SIDEBAR_SETTINGS_UPDATED_EVENT, handleSettingsUpdated as EventListener);
    return () =>
      window.removeEventListener(
        SIDEBAR_SETTINGS_UPDATED_EVENT,
        handleSettingsUpdated as EventListener
      );
  }, []);

  const radarAdmin = parseRadarAdminUrl(radarAdminUrl);
  const sections: ResolvedNavSection[] = resolveNavSections(
    new Set(hiddenSidebarItems),
    featureFlags,
    radarAdmin
      ? { costs: [{ href: radarAdmin, label: "Radar admin ↗", external: true }] }
      : undefined
  );

  const match = findNavMatch(pathname, sections);
  const activeEntryId = match?.entry.id ?? null;
  const currentAreaId = match?.section.id ?? sections[0]?.id ?? null;
  const selectedAreaId = browsedArea ?? currentAreaId;
  const selectedSection = sections.find((section) => section.id === selectedAreaId) ?? sections[0];

  const entriesById = new Map(
    sections.flatMap((section) => section.entries.map((entry) => [entry.id, entry] as const))
  );

  // Pinned pages: an entry, or any single page (kept from before pages became tabs).
  const pinnedItemList = Array.from(pinnedItems)
    .map((id): PanelItem | null => {
      const entry = entriesById.get(id);
      if (entry) return { ...entryItem(entry), group: undefined };
      for (const candidate of entriesById.values()) {
        const page = candidate.tabs.find((tabDefinition) => tabDefinition.id === id);
        if (page) return tabItem(candidate, page);
      }
      return null;
    })
    .filter((item): item is PanelItem => item !== null);

  // Search reaches every page of every area: "caveman" finds Token saver › Engines.
  const isSearching = searchQuery.trim().length > 0;
  const searchSections = sections.map((section) => ({
    id: section.id,
    title: section.title,
    children: section.entries.flatMap((entry) => [
      { ...entryItem(entry), group: undefined },
      ...entry.tabs
        .filter((page) => page.href !== entry.href)
        .map((page) => ({ ...tabItem(entry, page), label: `${entry.label} › ${page.label}` })),
    ]),
  }));

  let blocks: PanelBlock[];
  if (isSearching) {
    blocks = filterSidebarSectionsByQuery(searchSections, searchQuery).map((section) => ({
      id: section.id,
      heading: section.title,
      items: section.children,
    }));
  } else {
    blocks = [];
    if (pinnedItemList.length > 0) {
      blocks.push({
        id: "pinned",
        heading:
          typeof t.has === "function" && t.has("pinnedSection") ? t("pinnedSection") : "Pinned",
        items: pinnedItemList,
      });
    }
    if (selectedSection) {
      blocks.push({ id: selectedSection.id, items: selectedSection.entries.map(entryItem) });
    }
  }

  const togglePinItem = useCallback((itemId: string) => {
    setPinnedItems((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
      }
      saveToStorage(PINNED_ITEMS_KEY, [...next]);
      return next;
    });
  }, []);

  const handleShutdown = async () => {
    setIsShuttingDown(true);
    try {
      await fetch("/api/shutdown", { method: "POST" });
    } catch (e) {
      // Expected to fail as server shuts down
    }
    setIsShuttingDown(false);
    setShowShutdownModal(false);
    setIsDisconnected(true);
  };

  const handleRestart = async () => {
    setIsRestarting(true);
    try {
      await fetch("/api/restart", { method: "POST" });
    } catch (e) {
      // Expected to fail as server restarts
    }
    setIsRestarting(false);
    setShowRestartModal(false);
    setIsDisconnected(true);
    setTimeout(() => globalThis.location.reload(), 3000);
  };

  // Selecting another area browses it; selecting the current one opens or closes the panel.
  const selectArea = (id: string) => {
    if (onPanelOpenChange && id === selectedAreaId) {
      onPanelOpenChange(!panelOpen);
      return;
    }
    setBrowsedArea(id);
    onPanelOpenChange?.(true);
  };

  const railActions: RailAction[] = [
    ...(onOpenCommandPalette
      ? [
          {
            id: "search",
            label: tc("search"),
            icon: "Search",
            onSelect: onOpenCommandPalette,
          },
        ]
      : []),
    ...(onPanelOpenChange
      ? [
          {
            id: "panel",
            label: panelOpen ? t("collapseSidebar") : t("expandSidebar"),
            icon: panelOpen ? "PanelLeftClose" : "PanelLeftOpen",
            onSelect: () => onPanelOpenChange(!panelOpen),
          },
        ]
      : []),
    {
      id: "restart",
      label: t("restart"),
      icon: "RotateCw",
      onSelect: () => setShowRestartModal(true),
    },
    {
      id: "shutdown",
      label: t("shutdown"),
      icon: "Power",
      onSelect: () => setShowShutdownModal(true),
    },
  ];

  const safeTop = isMacElectron ? "var(--desktop-safe-top)" : undefined;

  return (
    <>
      <div className="flex h-full min-h-0">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:p-3 focus:bg-primary focus:text-white focus:rounded-md focus:m-2"
        >
          {t("skipToContent")}
        </a>
        <SidebarRail
          label={t("mainNavigation")}
          areas={sections.map((section) => ({
            id: section.id,
            label: section.title,
            icon: section.icon,
          }))}
          selectedId={selectedAreaId}
          onSelect={selectArea}
          paddingTop={safeTop}
          top={
            <Link href="/home" prefetch={false} title={brandName} aria-label={brandName}>
              <img
                src={brandLogo || "/favicon.svg"}
                alt=""
                className="size-[var(--reddb-spatial-control-height-md)] shrink-0 object-contain"
              />
            </Link>
          }
          actions={railActions}
        />
        {panelOpen && (
          <SidebarPanel
            label={t("mainNavigation")}
            title={selectedSection?.title ?? brandName}
            blocks={blocks}
            activeEntryId={activeEntryId}
            pinnedIds={pinnedItems}
            onTogglePin={togglePinItem}
            onNavigate={onClose}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            searchLabel={tc("search")}
            emptyLabel={tc("noResults")}
            pinLabel={t("pinItem")}
            unpinLabel={t("unpinItem")}
            isSearching={isSearching}
            paddingTop={safeTop}
            headingActions={
              onPanelOpenChange ? (
                <button
                  type="button"
                  onClick={() => onPanelOpenChange(false)}
                  title={t("collapseSidebar")}
                  aria-label={t("collapseSidebar")}
                  className="shrink-0 rounded-md p-1 text-ink-muted transition-colors hover:bg-foreground/8 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <Icon icon={navIcon("PanelLeftClose")} size="sm" color="current" />
                </button>
              ) : null
            }
            footer={
              <div className="flex flex-col">
                {!isE2EMode && <CloudSyncStatus collapsed={false} />}
                <p className="px-[var(--reddb-spatial-inset-sm)] py-[var(--reddb-spatial-gap-md)] text-[11px] text-ink-muted">
                  {brandName} v{APP_CONFIG.version}
                </p>
              </div>
            }
          />
        )}
      </div>

      <ConfirmModal
        isOpen={showShutdownModal}
        onClose={() => setShowShutdownModal(false)}
        onConfirm={handleShutdown}
        title={t("shutdown")}
        message={t("shutdownConfirm")}
        confirmText={t("shutdown")}
        cancelText={tc("cancel")}
        variant="danger"
        loading={isShuttingDown}
      />

      <ConfirmModal
        isOpen={showRestartModal}
        onClose={() => setShowRestartModal(false)}
        onConfirm={handleRestart}
        title={t("restart")}
        message={t("restartConfirm")}
        confirmText={t("restart")}
        cancelText={tc("cancel")}
        variant="warning"
        loading={isRestarting}
      />

      {isDisconnected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
          <div className="text-center p-8">
            <div className="mx-auto mb-4 flex size-16 items-center justify-center rounded-full bg-feedback-danger-surface text-feedback-danger-foreground">
              <Icon icon={navIcon("Power")} size="lg" color="current" />
            </div>
            <h2 className="text-xl font-semibold text-white mb-2">{t("serverDisconnected")}</h2>
            <p className="text-text-muted mb-6">{t("serverDisconnectedMsg")}</p>
            <Button variant="secondary" onClick={() => globalThis.location.reload()}>
              {t("reloadPage")}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
