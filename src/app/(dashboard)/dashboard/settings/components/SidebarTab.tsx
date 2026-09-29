"use client";

// Settings → Sidebar: which areas, entries and pages the menu shows. The tree is the menu itself
// (rail area → panel entry → page tab); every page keeps the hideable id it always had, so saved
// settings and presets keep working. An entry disappears when all of its identified pages are hidden.
import { useState, useEffect, useCallback } from "react";
import { Card, Toggle } from "@/shared/components";
import Icon from "@/shared/components/Icon";
import { cn } from "@/shared/utils/cn";
import { useTranslations } from "next-intl";
import { navIcon } from "@/shared/icons/navIcons";
import {
  HIDDEN_SIDEBAR_ITEMS_SETTING_KEY,
  SIDEBAR_PRESET_KEY,
  SIDEBAR_SECTION_ORDER_KEY,
  SIDEBAR_ITEM_ORDER_KEY,
  SIDEBAR_SETTINGS_UPDATED_EVENT,
  SIDEBAR_PRESETS,
  normalizeHiddenSidebarItems,
  type HideableSidebarItemId,
  type SidebarPresetId,
} from "@/shared/constants/sidebarVisibility";
import { HIDDEN_SIDEBAR_GROUP_LABELS_SETTING_KEY } from "@/shared/constants/sidebarGroupVisibility";
import {
  SIDEBAR_NAV_SECTIONS,
  type SidebarNavEntry,
  type SidebarNavTab,
} from "@/shared/constants/sidebarNav";

// Pages that can never be hidden, so Settings → Sidebar itself always stays reachable.
const PROTECTED_ITEM_IDS = new Set<string>(["settings-sidebar"]);

const pageIds = (entry: SidebarNavEntry): HideableSidebarItemId[] =>
  [
    ...entry.tabs.flatMap((page) => [page.id, ...(page.children ?? []).map((child) => child.id)]),
  ].filter((id): id is HideableSidebarItemId => Boolean(id));

interface EntryRowProps {
  entry: SidebarNavEntry;
  hidden: ReadonlySet<string>;
  disabled: boolean;
  onSetIds: (ids: readonly HideableSidebarItemId[], visible: boolean) => void;
  shownLabel: string;
  alwaysLabel: string;
}

function EntryRow({ entry, hidden, disabled, onSetIds, shownLabel, alwaysLabel }: EntryRowProps) {
  const ids = pageIds(entry);
  const visibleIds = ids.filter((id) => !hidden.has(id));
  const entryVisible = visibleIds.length > 0;
  const protectedEntry = ids.some((id) => PROTECTED_ITEM_IDS.has(id));
  const identifiedTabs = entry.tabs.filter((page: SidebarNavTab) => page.id);

  return (
    <div className="border-t border-border/50 first:border-t-0">
      <div className="flex items-center justify-between gap-4 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Icon icon={navIcon(entry.icon)} size="sm" color="ink-muted" />
          <p className="truncate text-sm font-medium">{entry.label}</p>
          {entry.group && <span className="text-xs text-ink-muted">· {entry.group}</span>}
        </div>
        <Toggle
          size="sm"
          checked={entryVisible}
          disabled={disabled || protectedEntry}
          ariaLabel={`${shownLabel}: ${entry.label}`}
          onChange={() => onSetIds(ids, !entryVisible)}
        />
      </div>
      {identifiedTabs.length > 1 && (
        <ul className="m-0 list-none pb-2 ps-10 pe-4">
          {identifiedTabs.map((page) => {
            const pageHidden = page.id ? hidden.has(page.id) : false;
            const protectedPage = Boolean(page.id && PROTECTED_ITEM_IDS.has(page.id));
            return (
              <li key={page.href} className="flex items-center justify-between gap-4 py-1">
                <span
                  className={cn(
                    "truncate text-sm",
                    pageHidden ? "text-ink-muted" : "text-foreground"
                  )}
                >
                  {page.label}
                  {page.secondary && <span className="text-xs text-ink-muted"> · More</span>}
                </span>
                <Toggle
                  size="sm"
                  checked={!pageHidden}
                  disabled={disabled || protectedPage}
                  ariaLabel={`${shownLabel}: ${entry.label} › ${page.label}`}
                  onChange={() =>
                    page.id &&
                    onSetIds(
                      [page.id, ...(page.children ?? []).flatMap((c) => (c.id ? [c.id] : []))],
                      pageHidden
                    )
                  }
                />
              </li>
            );
          })}
          {entry.tabs.some((page: SidebarNavTab) => !page.id) && (
            <li className="py-1 text-xs text-ink-muted">{alwaysLabel}</li>
          )}
        </ul>
      )}
    </div>
  );
}

export default function SidebarTab() {
  const t = useTranslations("settings");
  const getSettingsLabel = useCallback(
    (key: string, fallback: string) =>
      typeof t.has === "function" && t.has(key) ? t(key) : fallback,
    [t]
  );

  const [loading, setLoading] = useState(true);
  const [hiddenSidebarItems, setHiddenSidebarItems] = useState<HideableSidebarItemId[]>([]);
  const [activePreset, setActivePreset] = useState<SidebarPresetId | null>(null);
  const [confirmPreset, setConfirmPreset] = useState<SidebarPresetId | null>(null);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data) => {
        setHiddenSidebarItems(
          normalizeHiddenSidebarItems(data?.[HIDDEN_SIDEBAR_ITEMS_SETTING_KEY])
        );
        setActivePreset(data?.[SIDEBAR_PRESET_KEY] ?? null);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const patch = async (updates: Record<string, unknown>) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (res.ok) {
        window.dispatchEvent(new CustomEvent(SIDEBAR_SETTINGS_UPDATED_EVENT, { detail: updates }));
      } else {
        console.error("Failed to update sidebar settings:", res.statusText);
      }
    } catch (err) {
      console.error("Error updating sidebar settings:", err);
    }
  };

  const hidden = new Set<string>(hiddenSidebarItems);

  const setIds = (ids: readonly HideableSidebarItemId[], visible: boolean) => {
    const changing = ids.filter((id) => !PROTECTED_ITEM_IDS.has(id));
    const next = visible
      ? hiddenSidebarItems.filter((id) => !changing.includes(id))
      : [...new Set([...hiddenSidebarItems, ...changing])];
    setHiddenSidebarItems(next);
    // Any manual change → custom mode
    setActivePreset(null);
    patch({ [HIDDEN_SIDEBAR_ITEMS_SETTING_KEY]: next, [SIDEBAR_PRESET_KEY]: null });
  };

  const applyPreset = (presetId: SidebarPresetId) => {
    const preset = SIDEBAR_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    // Ensure protected items are never hidden, even if a preset includes them
    const safeHidden = preset.hiddenItems.filter((id) => !PROTECTED_ITEM_IDS.has(id));
    setHiddenSidebarItems(safeHidden);
    setActivePreset(presetId);
    setConfirmPreset(null);
    patch({
      [HIDDEN_SIDEBAR_ITEMS_SETTING_KEY]: safeHidden,
      // The menu no longer has orderable sections or group labels; clear what older versions saved.
      [HIDDEN_SIDEBAR_GROUP_LABELS_SETTING_KEY]: [],
      [SIDEBAR_SECTION_ORDER_KEY]: [],
      [SIDEBAR_ITEM_ORDER_KEY]: {},
      [SIDEBAR_PRESET_KEY]: presetId,
    });
  };

  const presetLabels: Record<SidebarPresetId, string> = {
    all: getSettingsLabel("presetAll", "All"),
    essentials: getSettingsLabel("presetEssentials", "Essentials"),
    minimal: getSettingsLabel("presetMinimal", "Minimal"),
    developer: getSettingsLabel("presetDeveloper", "Developer"),
    admin: getSettingsLabel("presetAdmin", "Admin"),
  };

  const presetDescriptions: Record<SidebarPresetId, string> = {
    all: getSettingsLabel("presetAllDesc", "Show everything"),
    essentials: getSettingsLabel(
      "presetEssentialsDesc",
      "Beginner path — Advanced tools stay searchable"
    ),
    minimal: getSettingsLabel("presetMinimalDesc", "Core pages only"),
    developer: getSettingsLabel("presetDeveloperDesc", "Dev & proxy tools"),
    admin: getSettingsLabel("presetAdminDesc", "Monitoring & audit"),
  };

  return (
    <Card>
      <div className="mb-4 flex items-center gap-3">
        <div className="rounded-lg bg-muted p-2 text-ink-muted">
          <Icon icon={navIcon("PanelLeft")} size="md" color="current" />
        </div>
        <div>
          <h3 className="text-lg font-semibold">
            {getSettingsLabel("settingsSidebarTitle", "Sidebar Customization")}
          </h3>
          <p className="text-sm text-text-muted">
            {getSettingsLabel(
              "settingsSidebarDesc",
              "Choose which areas, entries and pages the menu shows"
            )}
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-6">
        {/* Presets */}
        <div>
          <div className="mb-3">
            <p className="font-medium">{getSettingsLabel("sidebarPresets", "Presets")}</p>
            <p className="text-sm text-text-muted">
              {getSettingsLabel(
                "sidebarPresetsDesc",
                "Start from a role-based layout. Any change after applying a preset switches to Custom."
              )}
            </p>
          </div>

          <div className="mb-3 flex items-center gap-2 text-sm">
            <span className="text-text-muted">
              {getSettingsLabel("activePresetLabel", "Active:")}
            </span>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-xs font-medium",
                activePreset
                  ? "bg-foreground/10 text-foreground"
                  : "border border-border bg-surface text-text-muted"
              )}
            >
              {activePreset
                ? presetLabels[activePreset]
                : getSettingsLabel("presetCustom", "Custom")}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {SIDEBAR_PRESETS.map((preset) => {
              const isActive = activePreset === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  disabled={loading}
                  aria-pressed={isActive}
                  onClick={() => {
                    if (isActive) return;
                    if (activePreset !== null || hiddenSidebarItems.length > 0) {
                      setConfirmPreset(preset.id);
                    } else {
                      applyPreset(preset.id);
                    }
                  }}
                  className={cn(
                    "flex flex-col items-center gap-1.5 rounded-lg border p-3 transition-colors disabled:opacity-60",
                    isActive
                      ? "border-primary bg-foreground/10 text-foreground"
                      : "border-border bg-surface/40 text-text-main hover:bg-foreground/8"
                  )}
                >
                  <Icon icon={navIcon(preset.icon)} size="lg" color="current" />
                  <span className="text-sm font-semibold">{presetLabels[preset.id]}</span>
                  <span className="text-center text-[10px] text-text-muted">
                    {presetDescriptions[preset.id]}
                  </span>
                </button>
              );
            })}
          </div>

          {confirmPreset && (
            <div className="mt-3 flex items-center gap-3 rounded-lg border border-feedback-warning-border bg-feedback-warning-surface p-3">
              <Icon icon={navIcon("TriangleAlert")} size="md" color="feedback-warning-foreground" />
              <p className="flex-1 text-sm">
                {getSettingsLabel(
                  "presetConfirmWarning",
                  `Applying "${presetLabels[confirmPreset]}" will replace your current visibility settings.`
                )}
              </p>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmPreset(null)}
                  className="rounded-md border border-border px-3 py-1.5 text-sm transition-colors hover:bg-foreground/8"
                >
                  {getSettingsLabel("cancelLabel", "Cancel")}
                </button>
                <button
                  type="button"
                  onClick={() => applyPreset(confirmPreset)}
                  className="rounded-md border border-primary bg-foreground/10 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-foreground/15"
                >
                  {getSettingsLabel("applyLabel", "Apply")}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Visibility */}
        <div>
          <div className="mb-3 flex items-start justify-between gap-4">
            <div>
              <p className="font-medium">{getSettingsLabel("sidebarVisibility", "Visibility")}</p>
              <p className="text-sm text-text-muted">
                {getSettingsLabel(
                  "sidebarVisibilityDesc",
                  "Turn an entry off to hide it and all of its pages, or hide single pages. Pages you hide stay reachable from the search and the command palette."
                )}
              </p>
            </div>
            <button
              type="button"
              onClick={() => applyPreset("all")}
              disabled={loading}
              className="shrink-0 rounded-md border border-border px-3 py-1.5 text-sm text-text-muted transition-colors hover:bg-foreground/8 hover:text-text-main disabled:opacity-50"
            >
              {getSettingsLabel("resetDefault", "Reset to default")}
            </button>
          </div>

          <div className="flex flex-col gap-3">
            {SIDEBAR_NAV_SECTIONS.map((section) => (
              <section
                key={section.id}
                aria-label={section.title}
                className="overflow-hidden rounded-lg border border-border bg-surface/40"
              >
                <h4 className="flex items-center gap-2 border-b border-border/70 px-4 py-3 text-sm font-semibold">
                  <Icon icon={navIcon(section.icon)} size="sm" color="ink-muted" />
                  {section.title}
                </h4>
                {section.entries.map((entry) => (
                  <EntryRow
                    key={entry.id}
                    entry={entry}
                    hidden={hidden}
                    disabled={loading}
                    onSetIds={setIds}
                    shownLabel={getSettingsLabel("sidebarShown", "Show")}
                    alwaysLabel={getSettingsLabel(
                      "sidebarAlwaysShown",
                      "Other pages of this entry are always shown with it."
                    )}
                  />
                ))}
              </section>
            ))}
          </div>

          <p className="mt-3 text-xs text-text-muted">
            {getSettingsLabel(
              "sidebarVisibilityHint",
              "An entry hides automatically when all of its pages are hidden. Settings → Sidebar cannot be hidden."
            )}
          </p>
        </div>
      </div>
    </Card>
  );
}
