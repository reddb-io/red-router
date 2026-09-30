"use client";

// Phase 1t.7 extraction — Issue #3501
import { Link, Server, SlidersHorizontal } from "lucide-react";
import Icon from "@/shared/components/Icon";
import { Card } from "@/shared/components";
import type { ProviderMessageTranslator } from "../providerPageHelpers";

interface SearchProviderCardProps {
  providerId: string;
  t: ProviderMessageTranslator;
}

export default function SearchProviderCard({ providerId, t }: SearchProviderCardProps) {
  return (
    <Card>
      <h2 className="text-lg font-semibold mb-4">{t("searchProvider")}</h2>
      <p className="text-sm text-text-muted">{t("searchProviderDesc")}</p>
      {providerId === "perplexity-search" && (
        <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-feedback-info-surface border border-feedback-info-border">
          <Icon icon={Link} size="sm" color="current" />
          <p className="text-xs text-feedback-info-foreground">{t("perplexitySearchSharedKeyInfo")}</p>
        </div>
      )}
      {providerId === "google-pse-search" && (
        <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-feedback-warning-surface border border-feedback-warning-border">
          <Icon icon={SlidersHorizontal} size="sm" color="current" />
          <p className="text-xs text-feedback-warning-foreground">{t("googlePseInfo")}</p>
        </div>
      )}
      {providerId === "searxng-search" && (
        <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-feedback-success-surface border border-feedback-success-border">
          <Icon icon={Server} size="sm" color="current" />
          <p className="text-xs text-feedback-success-foreground">{t("searxngInfo")}</p>
        </div>
      )}
    </Card>
  );
}
