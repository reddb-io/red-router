"use client";

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/shared/utils/cn";
import { filterSidebarSectionsByQuery } from "@/shared/utils/sidebarSearch";
import { APP_CONFIG } from "@/shared/constants/appConfig";
import { displayInstanceName } from "@/shared/constants/productBranding";
import { useBranding } from "@/shared/components/BrandingProvider";
import { navItem } from "@/shared/design-system/contracts/nav-item.variants";
import Button from "./Button";
import Input from "./Input";
import { ConfirmModal } from "./Modal";
import CloudSyncStatus from "./CloudSyncStatus";
import { useTranslations } from "next-intl";
import {
  HIDDEN_SIDEBAR_ITEMS_SETTING_KEY,
  SIDEBAR_SETTINGS_UPDATED_EVENT,
  getSidebarIconAccent,
  normalizeHiddenSidebarItems,
} from "@/shared/constants/sidebarVisibility";
import {
  SIDEBAR_NAV_SECTIONS,
  findNavMatch,
  resolveNavSections,
  type ResolvedNavEntry,
  type SidebarNavTab,
} from "@/shared/constants/sidebarNav";
import { parseRadarAdminUrl } from "@/shared/validation/radarAdminUrl";

const isE2EMode = process.env.NEXT_PUBLIC_OMNIROUTE_E2E_MODE === "1";
const EXPANDED_SECTIONS_KEY = "sidebar-nav-expanded";
const PINNED_ITEMS_KEY = "sidebar-pinned-items";
const DEFAULT_EXPANDED: readonly string[] = SIDEBAR_NAV_SECTIONS.filter(
  (section) => !section.collapsedByDefault
).map((section) => section.id);

type SidebarGlyphStyle = CSSProperties & {
  "--sidebar-icon-accent": string;
  color: string;
};

type SidebarProps = {
  onClose?: () => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  isMacElectron?: boolean;
};

type HoveredItem = { id: string; label: string; x: number; y: number } | null;

/** One row of the menu: an entry, or (pinned / searched) one of an entry's pages. */
interface MenuItem {
  id: string;
  href: string;
  label: string;
  icon: string;
  accentId: string;
  external: boolean;
  /** Longer text for the row's tooltip. */
  description?: string;
  /** The entry this row belongs to, so it lights up for the current page. */
  entryId: string;
}

interface MenuSection {
  id: string;
  title: string;
  showTitle?: boolean;
  children: MenuItem[];
}

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

// useSyncExternalStore plumbing for the one-shot localStorage hydration reads:
// nothing to subscribe to (the values are only read once, before
// sidebarExpansionLoaded flips), and the server snapshot is always null so the
// SSR/hydration render matches the server output.
const noopSubscribe = () => () => {};
const getServerSnapshotNull = () => null;
const getHydratedSnapshot = () => true;
const getServerHydratedSnapshot = () => false;
function readStoredExpandedRaw() {
  try {
    return localStorage.getItem(EXPANDED_SECTIONS_KEY);
  } catch {
    return null;
  }
}
function readStoredPinnedItemsRaw() {
  try {
    return localStorage.getItem(PINNED_ITEMS_KEY);
  } catch {
    return null;
  }
}

const entryItem = (entry: ResolvedNavEntry): MenuItem => ({
  id: entry.id,
  href: entry.href,
  label: entry.label,
  icon: entry.icon,
  accentId: entry.accentId ?? entry.id,
  external: entry.external,
  entryId: entry.id,
});

const tabItem = (entry: ResolvedNavEntry, page: SidebarNavTab): MenuItem => ({
  id: page.id ?? page.href,
  href: page.href,
  label: page.label,
  icon: entry.icon,
  accentId: page.id ?? entry.accentId ?? entry.id,
  external: page.external === true,
  description: `${entry.label} › ${page.label}`,
  entryId: entry.id,
});

export default function Sidebar({
  onClose,
  collapsed = false,
  onToggleCollapse,
  isMacElectron = false,
}: SidebarProps) {
  const getIconStyle = (accentId: string): SidebarGlyphStyle => {
    const accent = getSidebarIconAccent(accentId);
    return {
      "--sidebar-icon-accent": accent,
      color: accent,
    };
  };
  const pathname = usePathname();
  const t = useTranslations("sidebar");
  const tc = useTranslations("common");
  const sidebarRef = useRef<HTMLElement>(null);
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
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(DEFAULT_EXPANDED));
  const [pinnedItems, setPinnedItems] = useState<Set<string>>(new Set());
  const [pinnedSectionCollapsed, setPinnedSectionCollapsed] = useState(false);
  const [sidebarExpansionLoaded, setSidebarExpansionLoaded] = useState(false);
  const [hoveredItem, setHoveredItem] = useState<HoveredItem>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const brand = useBranding();
  // A branding.json is the white-label source of truth; the dashboard
  // instance-name/logo settings apply when there is no branding file.
  const brandName = brand.custom ? brand.name : displayInstanceName(customAppName);
  const brandLogo = brand.custom ? brand.logo : customLogo;

  // Load persisted state once the client has hydrated. A stored [] intentionally
  // means "all sections collapsed". localStorage is read through
  // useSyncExternalStore snapshots (server snapshot: null) and the states are
  // adjusted during render (react.dev "You Might Not Need an Effect") so the
  // stored expansion applies before paint without a synchronous effect setState.
  const hydrated = useSyncExternalStore(
    noopSubscribe,
    getHydratedSnapshot,
    getServerHydratedSnapshot
  );
  const storedExpandedRaw = useSyncExternalStore(
    noopSubscribe,
    readStoredExpandedRaw,
    getServerSnapshotNull
  );
  const storedPinnedItemsRaw = useSyncExternalStore(
    noopSubscribe,
    readStoredPinnedItemsRaw,
    getServerSnapshotNull
  );
  if (hydrated && !sidebarExpansionLoaded) {
    setExpandedSections(
      new Set(parseStoredArray<string[]>(storedExpandedRaw, [...DEFAULT_EXPANDED]))
    );
    setPinnedItems(new Set(parseStoredArray<string[]>(storedPinnedItemsRaw, [])));
    setSidebarExpansionLoaded(true);
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

  const hiddenSidebarSet = new Set(hiddenSidebarItems);
  const radarAdmin = parseRadarAdminUrl(radarAdminUrl);
  const navSections = resolveNavSections(
    hiddenSidebarSet,
    featureFlags,
    radarAdmin
      ? { costs: [{ href: radarAdmin, label: "Radar admin ↗", external: true }] }
      : undefined
  );

  const navMatch = findNavMatch(pathname, navSections);
  const activeEntryId = navMatch?.entry.id ?? null;
  const activeSectionId = navMatch
    ? (navSections.find((section) => section.entries.some((e) => e.id === navMatch.entry.id))?.id ??
      null)
    : null;

  const entriesById = new Map(
    navSections.flatMap((section) => section.entries.map((entry) => [entry.id, entry] as const))
  );

  // Pinned pages: an entry, or any single page (kept from before pages became tabs).
  const pinnedItemList = Array.from(pinnedItems)
    .map((id): MenuItem | null => {
      const entry = entriesById.get(id);
      if (entry) return entryItem(entry);
      for (const candidate of entriesById.values()) {
        const page = candidate.tabs.find((tabDefinition) => tabDefinition.id === id);
        if (page) return tabItem(candidate, page);
      }
      return null;
    })
    .filter((item): item is MenuItem => item !== null);

  const menuSections: MenuSection[] = navSections.map((section) => ({
    id: section.id,
    title: section.title,
    showTitle: section.showTitle,
    children: section.entries.map(entryItem),
  }));

  const homeIndex = menuSections.findIndex((s) => s.id === "home");
  const insertIndex = homeIndex >= 0 ? homeIndex + 1 : 0;
  const pinnedSection: MenuSection = {
    id: "pinned",
    title: typeof t.has === "function" && t.has("pinnedSection") ? t("pinnedSection") : "Pinned",
    children: pinnedItemList,
  };
  const sectionsWithPinned =
    pinnedItemList.length > 0
      ? [...menuSections.slice(0, insertIndex), pinnedSection, ...menuSections.slice(insertIndex)]
      : menuSections;

  // Search reaches every page, not only the entries: "caveman" finds Token saver › Caveman.
  const isSearching = searchQuery.trim().length > 0;
  const searchSections: MenuSection[] = navSections.map((section) => ({
    id: section.id,
    title: section.title,
    children: section.entries.flatMap((entry) => [
      entryItem(entry),
      ...entry.tabs
        .filter((page) => page.href !== entry.href)
        .map((page) => ({ ...tabItem(entry, page), label: `${entry.label} › ${page.label}` })),
    ]),
  }));
  const displaySections: MenuSection[] = isSearching
    ? filterSidebarSectionsByQuery(searchSections, searchQuery)
    : sectionsWithPinned;

  // Keep the active page visible: render-time adjustment (react.dev "You Might Not Need an
  // Effect"), keyed on what the old effect depended on.
  const activeExpansionKey = `${collapsed}|${sidebarExpansionLoaded}|${activeSectionId ?? ""}`;
  const [prevActiveExpansionKey, setPrevActiveExpansionKey] = useState<string | null>(null);
  if (activeExpansionKey !== prevActiveExpansionKey) {
    setPrevActiveExpansionKey(activeExpansionKey);
    if (!collapsed && sidebarExpansionLoaded && activeSectionId) {
      setExpandedSections((prev) =>
        prev.has(activeSectionId) ? prev : new Set([...prev, activeSectionId])
      );
    }
  }

  // Persist the expanded-section set whenever it changes after hydration.
  useEffect(() => {
    if (!sidebarExpansionLoaded) return;
    saveToStorage(EXPANDED_SECTIONS_KEY, [...expandedSections]);
  }, [expandedSections, sidebarExpansionLoaded]);

  // Sections open and close independently.
  const toggleSection = useCallback((sectionId: string) => {
    if (sectionId === "pinned") {
      setPinnedSectionCollapsed((prev) => !prev);
      return;
    }
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(sectionId)) next.delete(sectionId);
      else next.add(sectionId);
      return next;
    });
  }, []);

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

  const handleMouseEnter = useCallback(
    (e: React.MouseEvent<HTMLElement>, id: string, label: string) => {
      if (!collapsed) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const sidebarRect = sidebarRef.current?.getBoundingClientRect();
      setHoveredItem({
        id,
        label,
        x: (sidebarRect?.right ?? 64) + 8,
        y: rect.top + rect.height / 2,
      });
    },
    [collapsed]
  );

  const handleMouseLeave = useCallback(() => setHoveredItem(null), []);

  const renderNavLink = (item: MenuItem, keyPrefix?: string) => {
    const active = !item.external && activeEntryId === item.entryId;
    const isItemPinned = pinnedItems.has(item.id);
    const itemKey = `${keyPrefix ?? "menu"}-${item.id}`;
    // The DS nav item: neutral selection surface plus a 2px primary bar on the start edge.
    const className = navItem({ active }).root({
      class: cn(
        "group min-h-[var(--reddb-spatial-control-height-md)] py-0 transition-colors",
        collapsed && "justify-center px-2"
      ),
    });
    const iconClassName = cn(
      "material-symbols-outlined text-[18px] shrink-0",
      active ? "fill-1" : "group-hover/nav-item:text-primary transition-colors"
    );
    const content = (
      <>
        <span className={iconClassName} style={getIconStyle(item.accentId)}>
          {item.icon}
        </span>
        {!collapsed && (
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{item.label}</span>
        )}
      </>
    );
    const sharedProps = {
      onMouseEnter: (e: React.MouseEvent<HTMLElement>) => handleMouseEnter(e, item.id, item.label),
      onMouseLeave: handleMouseLeave,
    };

    if (collapsed) {
      if (item.external) {
        return (
          <a
            key={itemKey}
            href={item.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={onClose}
            className={className}
            {...sharedProps}
          >
            {content}
          </a>
        );
      }

      return (
        <Link
          key={itemKey}
          href={item.href}
          prefetch={false}
          onClick={onClose}
          className={className}
          {...sharedProps}
        >
          {content}
        </Link>
      );
    }

    const pinButton = item.id !== "home" && (
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          togglePinItem(item.id);
        }}
        title={isItemPinned ? t("unpinItem") : t("pinItem")}
        aria-label={isItemPinned ? t("unpinItem") : t("pinItem")}
        className={cn(
          "absolute end-1 top-1/2 -translate-y-1/2 rounded p-0.5 transition-all",
          isItemPinned
            ? "text-primary opacity-100 hover:text-primary/80"
            : "text-text-muted/30 opacity-0 group-hover/nav-item:opacity-100 hover:text-text-muted/80"
        )}
      >
        <span
          className="material-symbols-outlined text-[13px]"
          style={{
            fontSize: "13px",
            ...(isItemPinned ? { fontVariationSettings: "'FILL' 1" } : {}),
          }}
        >
          push_pin
        </span>
      </button>
    );

    const containerClassName = navItem({ active }).root({
      class: "group/nav-item relative px-0 py-0 transition-colors",
    });
    const innerLinkClassName =
      "flex min-h-[var(--reddb-spatial-control-height-md)] min-w-0 flex-1 items-center gap-[var(--reddb-spatial-gap-md)] px-[var(--reddb-spatial-inset-sm)]";
    const rowTitle = item.description ?? item.label;

    if (item.external) {
      return (
        <div key={itemKey} className={containerClassName}>
          <a
            href={item.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={onClose}
            className={innerLinkClassName}
            title={rowTitle}
            {...sharedProps}
          >
            {content}
          </a>
          {pinButton}
        </div>
      );
    }

    return (
      <div key={itemKey} className={containerClassName}>
        <Link
          href={item.href}
          prefetch={false}
          onClick={onClose}
          className={innerLinkClassName}
          title={rowTitle}
          {...sharedProps}
        >
          {content}
        </Link>
        {pinButton}
      </div>
    );
  };

  return (
    <>
      <aside
        ref={sidebarRef}
        data-density="compact"
        className={cn(
          "flex h-full min-h-0 flex-col border-r border-black/5 bg-sidebar transition-[width] duration-200 ease-in-out dark:border-white/5",
          collapsed ? "w-16" : "w-[var(--rr-sidebar-width,240px)]"
        )}
        style={{ paddingTop: isMacElectron ? "var(--desktop-safe-top)" : undefined }}
      >
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:p-3 focus:bg-primary focus:text-white focus:rounded-md focus:m-2"
        >
          {t("skipToContent")}
        </a>

        <div
          className={cn("flex items-center gap-1 pb-2 pt-3", collapsed ? "flex-col px-2" : "px-3")}
        >
          <Link
            href="/home"
            prefetch={false}
            className={cn(
              "flex min-w-0 items-center",
              collapsed ? "justify-center" : "flex-1 gap-2"
            )}
          >
            {/* The operator's logo, or the RedRouter mark (public/favicon.svg). */}
            <img
              src={brandLogo || "/favicon.svg"}
              alt={brandName}
              className="size-7 shrink-0 object-contain"
            />
            {!collapsed && (
              <div className="flex flex-col min-w-0">
                <h1 className="text-sm font-semibold tracking-tight text-text-main truncate">
                  {brandName}
                </h1>
                <span className="text-[10px] text-text-muted">v{APP_CONFIG.version}</span>
              </div>
            )}
          </Link>
          {onToggleCollapse && (
            <button
              type="button"
              onClick={onToggleCollapse}
              title={collapsed ? t("expandSidebar") : t("collapseSidebar")}
              aria-expanded={!collapsed}
              aria-label={collapsed ? t("expandSidebar") : t("collapseSidebar")}
              className="shrink-0 rounded-md p-1 text-text-muted/50 transition-colors hover:bg-black/5 hover:text-text-muted dark:hover:bg-white/5"
            >
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                {collapsed ? "chevron_right" : "chevron_left"}
              </span>
            </button>
          )}
        </div>

        {!collapsed && (
          <div className="px-3 pb-1.5">
            <Input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={tc("search")}
              aria-label={tc("search")}
              icon="search"
              className="gap-0"
              inputClassName="py-1 text-xs"
            />
          </div>
        )}

        <nav
          aria-label={t("mainNavigation")}
          className={cn(
            "min-h-0 flex-1 overflow-y-auto py-1 custom-scrollbar",
            collapsed ? "px-2 space-y-0.5" : "px-2"
          )}
        >
          {isSearching && displaySections.length === 0 && (
            <p className="px-2 py-3 text-xs text-text-muted/60">{tc("noResults")}</p>
          )}
          {displaySections.map((section, idx) => {
            const sectionId = section.id;
            const isExpanded =
              isSearching ||
              (sectionId === "pinned" ? !pinnedSectionCollapsed : expandedSections.has(sectionId));
            const isFirst = idx === 0;
            const keyPrefix =
              sectionId === "pinned" ? "pinned" : isSearching ? "search" : undefined;

            // Collapsed (mini) mode: flat items with dividers between sections
            if (collapsed) {
              return (
                <div key={section.id}>
                  {!isFirst && (
                    <div className="border-t border-black/5 dark:border-white/5 my-1.5" />
                  )}
                  {section.children.map((item) => renderNavLink(item, keyPrefix))}
                </div>
              );
            }

            // Sections without a visible title (Home) render items directly
            if (section.showTitle === false) {
              return (
                <div key={section.id} className={cn("space-y-0.5", !isFirst && "mt-1")}>
                  {section.children.map((item) => renderNavLink(item, keyPrefix))}
                </div>
              );
            }

            return (
              <div key={section.id} className={isFirst ? "space-y-0.5" : "mt-1"}>
                <div
                  className="flex items-center gap-0.5 px-2 py-0.5 rounded-md hover:bg-surface/30 transition-colors cursor-pointer group/header"
                  onClick={() => toggleSection(sectionId)}
                  role="button"
                  aria-expanded={isExpanded}
                >
                  <span className="flex-1 text-[11px] font-semibold text-text-muted/70 tracking-wide group-hover/header:text-text-muted/90 transition-colors">
                    {section.title}
                  </span>
                  <span
                    className={cn(
                      "material-symbols-outlined text-[14px] text-text-muted/40 transition-all duration-200 group-hover/header:text-text-muted/70 shrink-0",
                      isExpanded && "rotate-180"
                    )}
                  >
                    expand_more
                  </span>
                </div>

                {isExpanded && (
                  <div className="mt-0.5 space-y-0.5">
                    {section.children.map((item) => renderNavLink(item, keyPrefix))}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        {!isE2EMode && <CloudSyncStatus collapsed={collapsed} />}

        <div
          className={cn(
            "shrink-0 border-t border-black/5 dark:border-white/5",
            collapsed ? "p-2 flex flex-col gap-1" : "p-2 flex gap-2"
          )}
          style={{
            paddingBottom: isMacElectron ? "calc(0.5rem + var(--desktop-safe-bottom))" : undefined,
          }}
        >
          <button
            onClick={() => setShowRestartModal(true)}
            title={t("restart")}
            className={cn(
              "flex items-center justify-center gap-2 rounded-lg font-medium transition-all",
              "text-amber-500 hover:bg-amber-500/10 border border-amber-500/20 hover:border-amber-500/40",
              collapsed ? "p-2" : "flex-1 min-w-0 px-2 py-1 text-[11px]"
            )}
          >
            <span className="material-symbols-outlined text-[16px]">restart_alt</span>
            {!collapsed && <span className="truncate">{t("restart")}</span>}
          </button>
          <button
            onClick={() => setShowShutdownModal(true)}
            title={t("shutdown")}
            className={cn(
              "flex items-center justify-center gap-2 rounded-lg font-medium transition-all",
              "text-red-500 hover:bg-red-500/10 border border-red-500/20 hover:border-red-500/40",
              collapsed ? "p-2" : "flex-1 min-w-0 px-2 py-1 text-[11px]"
            )}
          >
            <span className="material-symbols-outlined text-[16px]">power_settings_new</span>
            {!collapsed && <span className="truncate">{t("shutdown")}</span>}
          </button>
        </div>
      </aside>

      {/* Styled tooltip for collapsed (mini) sidebar */}
      {collapsed && hoveredItem && (
        <div
          className="fixed z-[200] pointer-events-none flex items-center"
          style={{ left: hoveredItem.x, top: hoveredItem.y, transform: "translateY(-50%)" }}
        >
          <div className="w-0 h-0 border-t-[5px] border-b-[5px] border-r-[6px] border-t-transparent border-b-transparent border-r-sidebar dark:border-r-sidebar" />
          <div className="px-2.5 py-1.5 bg-sidebar text-text-main text-xs font-medium rounded-md shadow-lg border border-black/10 dark:border-white/10 whitespace-nowrap">
            {hoveredItem.label}
          </div>
        </div>
      )}

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
            <div className="flex items-center justify-center size-16 rounded-full bg-red-500/20 text-red-500 mx-auto mb-4">
              <span className="material-symbols-outlined text-[32px]">power_off</span>
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
