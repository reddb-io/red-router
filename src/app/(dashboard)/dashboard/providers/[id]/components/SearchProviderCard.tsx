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
        <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-500/10 border border-blue-500/20">
          <Icon icon={Link} size="sm" color="current" />
          <p className="text-xs text-blue-300">{t("perplexitySearchSharedKeyInfo")}</p>
        </div>
      )}
      {providerId === "google-pse-search" && (
        <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20">
          <Icon icon={SlidersHorizontal} size="sm" color="feedback-warning-foreground" />
          <p className="text-xs text-amber-200">{t("googlePseInfo")}</p>
        </div>
      )}
      {providerId === "searxng-search" && (
        <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
          <Icon icon={Server} size="sm" color="feedback-success-foreground" />
          <p className="text-xs text-emerald-200">{t("searxngInfo")}</p>
        </div>
      )}
    </Card>
  );
}
