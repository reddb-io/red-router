"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { cn } from "@/shared/utils/cn";
import { navItem } from "@/shared/design-system/contracts/nav-item.variants";
import { sidebarNavigation } from "@/shared/design-system/contracts/sidebar-navigation.variants";
import Icon from "@/shared/components/Icon";
import Input from "@/shared/components/Input";
import { navIcon } from "@/shared/icons/navIcons";

/** One row of the panel: an entry, or (pinned / searched) one of an entry's pages. */
export interface PanelItem {
  id: string;
  href: string;
  label: string;
  /** A lucide glyph name. */
  icon: string;
  external: boolean;
  /** Longer text for the row's tooltip. */
  description?: string;
  /** The entry this row belongs to, so it is marked current for the page being viewed. */
  entryId: string;
  /** Rows sharing a group are listed under its micro-label. */
  group?: string;
}

export interface PanelBlock {
  id: string;
  /** A micro-label above the block (search results are grouped by area). */
  heading?: string;
  items: readonly PanelItem[];
}

interface SidebarPanelProps {
  label: string;
  title: string;
  blocks: readonly PanelBlock[];
  activeEntryId: string | null;
  pinnedIds: ReadonlySet<string>;
  onTogglePin: (id: string) => void;
  onNavigate?: () => void;
  searchQuery: string;
  onSearchChange: (value: string) => void;
  searchLabel: string;
  emptyLabel: string;
  pinLabel: string;
  unpinLabel: string;
  isSearching: boolean;
  /** Rendered under the list: version, cloud sync. */
  footer?: ReactNode;
  /** Buttons at the end of the heading row (close panel). */
  headingActions?: ReactNode;
  paddingTop?: string;
}

/**
 * The side panel: the entries of the selected area as DS navigation rows (`nav-item` inside the
 * `sidebar-navigation` list). Icons are neutral ink: muted at rest, foreground when current.
 */
export default function SidebarPanel({
  label,
  title,
  blocks,
  activeEntryId,
  pinnedIds,
  onTogglePin,
  onNavigate,
  searchQuery,
  onSearchChange,
  searchLabel,
  emptyLabel,
  pinLabel,
  unpinLabel,
  isSearching,
  footer,
  headingActions,
  paddingTop,
}: SidebarPanelProps) {
  const slots = sidebarNavigation();

  const renderRow = (item: PanelItem) => {
    const active = !item.external && activeEntryId === item.entryId;
    const pinned = pinnedIds.has(item.id);
    const rowClass = navItem({ active }).root({
      class: "group/nav-item relative min-h-[var(--reddb-spatial-control-height-md)] px-0 py-0",
    });
    const linkClass =
      "flex min-h-[var(--reddb-spatial-control-height-md)] min-w-0 flex-1 items-center gap-[var(--reddb-spatial-gap-md)] px-[var(--reddb-spatial-inset-sm)]";
    const content = (
      <>
        <Icon icon={navIcon(item.icon)} size="sm" color="current" />
        <span className="min-w-0 flex-1 truncate text-[13px]">{item.label}</span>
      </>
    );
    return (
      <li key={`${item.id}-${item.href}`} className={slots.item()}>
        <div className={rowClass}>
          {item.external ? (
            <a
              href={item.href}
              target="_blank"
              rel="noopener noreferrer"
              className={linkClass}
              title={item.description ?? item.label}
              onClick={onNavigate}
            >
              {content}
            </a>
          ) : (
            <Link
              href={item.href}
              prefetch={false}
              className={linkClass}
              title={item.description ?? item.label}
              aria-current={active ? "page" : undefined}
              onClick={onNavigate}
            >
              {content}
            </Link>
          )}
          {item.id !== "home" && (
            <button
              type="button"
              title={pinned ? unpinLabel : pinLabel}
              aria-label={pinned ? unpinLabel : pinLabel}
              aria-pressed={pinned}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onTogglePin(item.id);
              }}
              className={cn(
                "absolute end-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-ink-muted transition-opacity",
                "hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                pinned ? "opacity-100" : "opacity-0 group-hover/nav-item:opacity-100"
              )}
            >
              <Icon icon={navIcon(pinned ? "PinOff" : "Pin")} size="sm" color="current" />
            </button>
          )}
        </div>
      </li>
    );
  };

  const renderBlock = (block: PanelBlock) => {
    // Rows of one group sit under its micro-label; ungrouped rows come first.
    const ungrouped = block.items.filter((item) => !item.group);
    const groups = [...new Set(block.items.flatMap((item) => (item.group ? [item.group] : [])))];
    return (
      <section key={block.id} className="flex flex-col gap-[var(--reddb-spatial-gap-sm)]">
        {block.heading && (
          <h3 className="px-[var(--reddb-spatial-inset-sm)] pt-[var(--reddb-spatial-gap-md)] text-[11px] font-medium uppercase tracking-wider text-ink-muted">
            {block.heading}
          </h3>
        )}
        {ungrouped.length > 0 && <ul className={slots.list()}>{ungrouped.map(renderRow)}</ul>}
        {groups.map((group) => (
          <div key={group} className="flex flex-col gap-[var(--reddb-spatial-gap-sm)]">
            <h3 className="px-[var(--reddb-spatial-inset-sm)] pt-[var(--reddb-spatial-gap-md)] text-[11px] font-medium uppercase tracking-wider text-ink-muted">
              {group}
            </h3>
            <ul className={slots.list()}>
              {block.items.filter((item) => item.group === group).map(renderRow)}
            </ul>
          </div>
        ))}
      </section>
    );
  };

  return (
    <aside
      aria-label={label}
      data-density="compact"
      className={cn(slots.root(), "h-full min-h-0 shrink-0 border-e")}
      style={{ width: "var(--rr-sidebar-panel-width, 288px)", paddingTop }}
    >
      <div className="flex items-center gap-1 px-[var(--reddb-spatial-inset-sm)] pb-[var(--reddb-spatial-gap-md)] pt-[var(--reddb-spatial-inset-sm)]">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
          {isSearching ? searchLabel : title}
        </h2>
        {headingActions}
      </div>
      <div className="px-[var(--reddb-spatial-inset-sm)] pb-[var(--reddb-spatial-gap-md)]">
        <Input
          type="search"
          value={searchQuery}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={searchLabel}
          aria-label={searchLabel}
          className="gap-0"
          inputClassName="py-1 text-xs"
        />
      </div>
      <nav
        aria-label={label}
        className="custom-scrollbar min-h-0 flex-1 overflow-y-auto px-[var(--reddb-spatial-inset-sm)] pb-[var(--reddb-spatial-inset-sm)]"
      >
        {isSearching && blocks.length === 0 && (
          <p className="px-[var(--reddb-spatial-inset-sm)] py-3 text-xs text-ink-muted">
            {emptyLabel}
          </p>
        )}
        <div className="flex flex-col gap-[var(--reddb-spatial-gap-sm)]">
          {blocks.map(renderBlock)}
        </div>
      </nav>
      {footer && <div className="shrink-0 border-t border-elevation-sunken-border">{footer}</div>}
    </aside>
  );
}
