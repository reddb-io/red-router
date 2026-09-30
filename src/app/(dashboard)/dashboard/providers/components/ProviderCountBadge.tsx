"use client";

import { useTranslations } from "next-intl";

interface ProviderCountBadgeProps {
  configured: number;
  total: number;
}

export default function ProviderCountBadge({ configured, total }: ProviderCountBadgeProps) {
  const t = useTranslations("providers");

  if (total === 0) return null;

  // A count is a fact, not a state: neutral ink, stronger once something is configured.
  const colorClass = configured === 0 ? "text-text-muted" : "text-text-main";

  return (
    <span
      className={`text-xs font-medium ${colorClass}`}
      title={t("configuredCount", { configured, total })}
    >
      {configured}/{total}
    </span>
  );
}
