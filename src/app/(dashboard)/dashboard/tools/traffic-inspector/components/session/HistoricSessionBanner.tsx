"use client";

import { History } from "lucide-react";
import Icon from "@/shared/components/Icon";
import { useTranslations } from "next-intl";

interface HistoricSessionBannerProps {
  sessionName: string | null;
  onBackToLive: () => void;
}

export function HistoricSessionBanner({ sessionName, onBackToLive }: HistoricSessionBannerProps) {
  const t = useTranslations("trafficInspector");
  return (
    <div className="flex items-center justify-between gap-3 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
      <div className="flex items-center gap-2">
        <Icon icon={History} size="md" color="current" />
        <span>
          {t("viewingRecordedSession")} —{" "}
          <strong>{sessionName ?? t("untitledSession")}</strong>
        </span>
      </div>
      <button
        type="button"
        onClick={onBackToLive}
        className="rounded border border-amber-500/40 px-2 py-0.5 text-xs hover:bg-amber-500/20 focus-ring"
      >
        {t("backToLive")}
      </button>
    </div>
  );
}
