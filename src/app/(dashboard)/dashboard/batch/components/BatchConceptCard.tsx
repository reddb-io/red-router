"use client";

import { CircleCheckBig, Clock, Info, PiggyBank, Timer } from "lucide-react";
import Icon from "@/shared/components/Icon";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

const LS_KEY = "omniroute:concept-batch-collapsed";

interface Props {
  className?: string;
}

export default function BatchConceptCard({ className = "" }: Props) {
  const t = useTranslations("common");
  // Default: expanded (collapsed=false) on first visit
  const [collapsed, setCollapsed] = useState(false);

  // Hydrate from localStorage after mount (avoids SSR mismatch)
  useEffect(() => {
    try {
      const stored = localStorage.getItem(LS_KEY);
      if (stored !== null) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage hydration, runs once
        setCollapsed(stored === "true");
      }
    } catch {
      // localStorage unavailable (SSR/private mode) — keep default
    }
  }, []);

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(LS_KEY, String(next));
    } catch {
      // ignore
    }
  };

  return (
    <div
      className={`rounded-xl bg-[var(--color-surface)] border border-[var(--color-border)] p-4 flex flex-col gap-3 ${className}`}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon icon={Info} size="lg" color="current" />
          <span className="font-semibold text-sm text-[var(--color-text-main)]">
            {t("batchConceptTitle")}
          </span>
        </div>
        <button
          onClick={toggle}
          className="flex items-center gap-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-main)] transition-colors"
          aria-expanded={!collapsed}
        >
          {t("batchConceptHowItWorks")}
          <span className="material-symbols-outlined text-[14px]">
            {collapsed ? "expand_more" : "expand_less"}
          </span>
        </button>
      </div>

      {/* Subtitle — always visible */}
      <p className="text-sm text-[var(--color-text-muted)]">{t("batchConceptSubtitle")}</p>

      {/* Expandable bullets — keys from §3.5 */}
      {!collapsed && (
        <ul className="flex flex-col gap-2 pl-1">
          <li className="flex items-start gap-2 text-sm text-[var(--color-text-muted)]">
            <Icon icon={PiggyBank} size="md" color="feedback-success-foreground" className="mt-0.5 shrink-0" />
            <span>{t("batchConceptBenefit50pct")}</span>
          </li>
          <li className="flex items-start gap-2 text-sm text-[var(--color-text-muted)]">
            <Icon icon={Clock} size="md" color="current" className="mt-0.5 shrink-0" />
            <span>{t("batchConceptAsync24h")}</span>
          </li>
          <li className="flex items-start gap-2 text-sm text-[var(--color-text-muted)]">
            <Icon icon={CircleCheckBig} size="md" color="current" className="mt-0.5 shrink-0" />
            <span>{t("batchConceptUseCases")}</span>
          </li>
          <li className="flex items-start gap-2 text-sm text-[var(--color-text-muted)]">
            <Icon icon={Timer} size="md" color="feedback-warning-foreground" className="mt-0.5 shrink-0" />
            <span>{t("batchConceptRetentionNote")}</span>
          </li>
        </ul>
      )}
    </div>
  );
}
