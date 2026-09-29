"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { cn } from "@/shared/utils/cn";
import { tabs as tabsContract } from "@/shared/design-system/contracts/tabs.variants";
import { useNavVisibility } from "@/shared/hooks/useNavVisibility";
import Icon from "@/shared/components/Icon";
import { navIcon } from "@/shared/icons/navIcons";
import {
  findNavMatch,
  resolveNavSections,
  splitNavTabs,
  type SidebarNavTab,
} from "@/shared/constants/sidebarNav";

/**
 * The pages of the menu entry the operator is in, as a tab bar above the page (DS `tabs`
 * appearance: a 2px primary bar under the current one). Every tab is a regular route, so links,
 * bookmarks and the command palette keep working; the bar only shows when the entry has more than
 * one visible page, and the rarely used pages of a long entry sit behind "More".
 */
export default function RouteTabs() {
  const pathname = usePathname();
  const t = useTranslations("sidebar");
  const { hidden, flags, radarAdmin } = useNavVisibility();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!moreOpen) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (event instanceof MouseEvent && moreRef.current?.contains(event.target as Node)) return;
      setMoreOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [moreOpen]);

  const sections = resolveNavSections(
    hidden,
    flags,
    radarAdmin
      ? { costs: [{ href: radarAdmin, label: "Radar admin ↗", external: true }] }
      : undefined
  );
  const match = findNavMatch(pathname, sections);
  if (!match || match.entry.tabs.length < 2) return null;

  const slots = tabsContract();
  const { primary, more } = splitNavTabs(match.entry.tabs);
  const currentInMore = more.includes(match.tab);

  const renderTab = (page: SidebarNavTab, className: string, state: "active" | "inactive") =>
    page.external ? (
      <a
        key={page.href}
        href={page.href}
        target="_blank"
        rel="noopener noreferrer"
        data-state={state}
        className={className}
      >
        {page.label}
      </a>
    ) : (
      <Link
        key={page.href}
        href={page.href}
        prefetch={false}
        data-state={state}
        aria-current={state === "active" ? "page" : undefined}
        className={className}
      >
        {page.label}
      </Link>
    );

  const triggerClass = cn(
    slots.trigger(),
    "inline-flex shrink-0 items-center whitespace-nowrap px-[var(--reddb-spatial-inset-sm)] text-[13px]",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
  );

  return (
    <nav
      aria-label={`${match.entry.label} — ${t("sectionPages")}`}
      className={cn(slots.list(), "mb-4 shrink-0 items-end")}
    >
      {primary.map((page) =>
        renderTab(page, triggerClass, page === match.tab ? "active" : "inactive")
      )}
      {more.length > 0 && (
        <div ref={moreRef} className="relative shrink-0">
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            data-state={currentInMore ? "active" : "inactive"}
            onClick={() => setMoreOpen((open) => !open)}
            className={cn(triggerClass, "gap-1")}
          >
            {currentInMore ? match.tab.label : t("moreTabs")}
            <Icon icon={navIcon("ChevronDown")} size="sm" color="current" />
          </button>
          {moreOpen && (
            <ul
              role="menu"
              className="absolute end-0 top-full z-30 mt-1 min-w-44 list-none rounded-md border border-elevation-overlay-border bg-elevation-overlay-surface p-[var(--reddb-spatial-gap-sm)] shadow-elevation-overlay"
            >
              {more.map((page) => (
                <li key={page.href} role="none">
                  {renderTab(
                    page,
                    cn(
                      "flex min-h-[var(--reddb-spatial-control-height-sm)] items-center rounded-md px-[var(--reddb-spatial-inset-sm)] text-[13px] hover:bg-foreground/8",
                      page === match.tab
                        ? "bg-foreground/10 font-medium text-foreground"
                        : "text-ink-muted"
                    ),
                    page === match.tab ? "active" : "inactive"
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </nav>
  );
}
