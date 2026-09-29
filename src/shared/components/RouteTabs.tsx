"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { cn } from "@/shared/utils/cn";
import { useNavVisibility } from "@/shared/hooks/useNavVisibility";
import { findNavMatch, resolveNavSections } from "@/shared/constants/sidebarNav";

/**
 * The pages of the menu entry the operator is in, as a tab bar above the page. Every tab is a
 * regular route, so links, bookmarks and the command palette keep working; the bar only shows when
 * the entry has more than one visible page.
 */
export default function RouteTabs() {
  const pathname = usePathname();
  const t = useTranslations("sidebar");
  const { hidden, flags, radarAdmin } = useNavVisibility();
  const sections = resolveNavSections(
    hidden,
    flags,
    radarAdmin
      ? { costs: [{ href: radarAdmin, label: "Radar admin ↗", external: true }] }
      : undefined
  );
  const match = findNavMatch(pathname, sections);
  if (!match || match.entry.tabs.length < 2) return null;

  return (
    <nav
      aria-label={`${match.entry.label} — ${t("sectionPages")}`}
      className="-mx-1 mb-4 flex shrink-0 gap-1 overflow-x-auto border-b border-black/10 px-1 custom-scrollbar dark:border-white/10"
    >
      {match.entry.tabs.map((page) => {
        const active = page === match.tab;
        const className = cn(
          "-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-1.5 text-[13px] font-medium transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
          active
            ? "border-primary text-foreground"
            : "border-transparent text-ink-muted hover:border-foreground/20 hover:text-foreground"
        );
        return page.external ? (
          <a
            key={page.href}
            href={page.href}
            target="_blank"
            rel="noopener noreferrer"
            className={className}
          >
            {page.label}
          </a>
        ) : (
          <Link
            key={page.href}
            href={page.href}
            prefetch={false}
            aria-current={active ? "page" : undefined}
            className={className}
          >
            {page.label}
          </Link>
        );
      })}
    </nav>
  );
}
