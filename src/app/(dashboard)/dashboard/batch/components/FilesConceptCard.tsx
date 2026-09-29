"use client";

import { CalendarCheck, CircleAlert, Download, FileUp, Info } from "lucide-react";
import Icon from "@/shared/components/Icon";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

const LS_KEY = "omniroute:concept-files-collapsed";

interface Props {
  className?: string;
}

const TYPE_PILLS: Array<{
  key: "filesConceptInput" | "filesConceptOutput" | "filesConceptError";
  color: string;
}> = [
  { key: "filesConceptInput", color: "bg-blue-500/15 text-blue-400 border-blue-500/25" },
  { key: "filesConceptOutput", color: "bg-emerald-500/15 text-emerald-400 border-emerald-500/25" },
  { key: "filesConceptError", color: "bg-red-500/15 text-red-400 border-red-500/25" },
];

export default function FilesConceptCard({ className = "" }: Props) {
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
      // localStorage unavailable — keep default
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
            {t("filesConceptTitle")}
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
      <p className="text-sm text-[var(--color-text-muted)]">{t("filesConceptSubtitle")}</p>

      {/* 3 type pills — always visible */}
      <div className="flex flex-wrap gap-2">
        {TYPE_PILLS.map(({ key, color }) => (
          <span
            key={key}
            className={`inline-block px-2 py-0.5 rounded-md text-xs font-medium border ${color}`}
          >
            {t(key)}
          </span>
        ))}
      </div>

      {/* Expandable bullets */}
      {!collapsed && (
        <ul className="flex flex-col gap-2 pl-1">
          <li className="flex items-start gap-2 text-sm text-[var(--color-text-muted)]">
            <Icon icon={FileUp} size="md" color="current" className="mt-0.5 shrink-0" />
            <span>{t("filesConceptInput")}</span>
          </li>
          <li className="flex items-start gap-2 text-sm text-[var(--color-text-muted)]">
            <Icon icon={Download} size="md" color="feedback-success-foreground" className="mt-0.5 shrink-0" />
            <span>{t("filesConceptOutput")}</span>
          </li>
          <li className="flex items-start gap-2 text-sm text-[var(--color-text-muted)]">
            <Icon icon={CircleAlert} size="md" color="feedback-danger-foreground" className="mt-0.5 shrink-0" />
            <span>{t("filesConceptError")}</span>
          </li>
          <li className="flex items-start gap-2 text-sm text-[var(--color-text-muted)]">
            <Icon icon={CalendarCheck} size="md" color="feedback-warning-foreground" className="mt-0.5 shrink-0" />
            <span>{t("filesConceptRetention")}</span>
          </li>
        </ul>
      )}
    </div>
  );
}
