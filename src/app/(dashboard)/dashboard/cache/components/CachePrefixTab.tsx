"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Badge, Button, Card, EmptyState } from "@/shared/components";

interface ModelRow {
  provider: string | null;
  model: string | null;
  followUpRequests: number;
  appendOnlyShare: number;
  stablePrefixShare: number;
  tokensInput: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  cacheReadShare: number | null;
  cacheWriteShare: number | null;
}

interface PrefixSummary {
  days: number;
  followUpRequests: number;
  byCause: { cause: string; requests: number }[];
  byModel: ModelRow[];
}

// What each cause means for the provider's prompt cache, in the operator's words.
const CAUSES: Record<string, string> = {
  none: "Only appended: the cache can hold",
  history_mutated: "An earlier message was rewritten (compression or a filter)",
  tools_changed: "The tool list changed",
  system_changed: "The system prompt changed",
  thinking_changed: "The thinking or effort setting changed",
  tool_choice_changed: "The tool choice changed",
  history_truncated: "The history got shorter",
  account_changed: "Another account served the request (caches do not cross accounts)",
};

const percent = (value: number | null) => (value === null ? "—" : `${(value * 100).toFixed(1)}%`);
const millions = (value: number) => `${(value / 1e6).toFixed(1)}M`;

/** Writes far above reads: the cache is paid for but never read back. */
const wastesWrites = (row: ModelRow) =>
  (row.cacheWriteShare ?? 0) > 0.15 && (row.cacheReadShare ?? 0) < (row.cacheWriteShare ?? 0) / 2;

export default function CachePrefixTab() {
  const t = useTranslations("cache");
  const [summary, setSummary] = useState<PrefixSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const fetchSummary = useCallback(async (): Promise<PrefixSummary> => {
    const response = await fetch("/api/cache/prefix?days=7", { cache: "no-store" });
    if (!response.ok) throw new Error(String(response.status));
    return (await response.json()) as PrefixSummary;
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchSummary()
      .then((data) => {
        if (!cancelled) setSummary(data);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchSummary]);

  // Only called from a click, never from an effect body.
  const reload = () => {
    setLoading(true);
    setFailed(false);
    fetchSummary()
      .then(setSummary)
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
  };

  if (loading) return <div className="h-48 animate-pulse rounded-lg bg-muted" aria-busy="true" />;
  if (failed || !summary) {
    return (
      <EmptyState
        icon="cached"
        title={t("prefixUnavailable")}
        description={t("prefixUnavailableDesc")}
        actionLabel={t("refresh")}
        onAction={reload}
      />
    );
  }
  if (summary.followUpRequests === 0) {
    return (
      <EmptyState icon="cached" title={t("prefixNoData")} description={t("prefixNoDataDesc")} />
    );
  }

  return (
    <div className="flex flex-col gap-[var(--reddb-spatial-gap-lg)]">
      <div className="flex items-start justify-between gap-4">
        <p className="max-w-prose text-sm text-ink-muted">
          {t("prefixIntro", { days: summary.days, count: summary.followUpRequests })}
        </p>
        <Button variant="secondary" size="sm" icon="refresh" onClick={reload}>
          {t("refresh")}
        </Button>
      </div>

      <Card title={t("prefixByModel")} subtitle={t("prefixByModelDesc")}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-muted text-left text-xs text-ink-muted">
                <th className="py-2 pe-4 font-medium">{t("prefixColModel")}</th>
                <th className="py-2 pe-4 text-end font-medium">{t("prefixColRequests")}</th>
                <th className="py-2 pe-4 text-end font-medium">{t("prefixColAppend")}</th>
                <th className="py-2 pe-4 text-end font-medium">{t("prefixColStable")}</th>
                <th className="py-2 pe-4 text-end font-medium">{t("prefixColInput")}</th>
                <th className="py-2 pe-4 text-end font-medium">{t("prefixColRead")}</th>
                <th className="py-2 pe-4 text-end font-medium">{t("prefixColWrite")}</th>
                <th className="py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {summary.byModel.map((row) => (
                <tr
                  key={`${row.provider}/${row.model}`}
                  className="border-b border-muted last:border-b-0"
                >
                  <td className="py-2 pe-4 font-mono text-xs">
                    {row.provider}/{row.model}
                  </td>
                  <td className="py-2 pe-4 text-end tabular-nums">{row.followUpRequests}</td>
                  <td className="py-2 pe-4 text-end tabular-nums">{percent(row.appendOnlyShare)}</td>
                  <td className="py-2 pe-4 text-end tabular-nums">{percent(row.stablePrefixShare)}</td>
                  <td className="py-2 pe-4 text-end tabular-nums">{millions(row.tokensInput)}</td>
                  <td className="py-2 pe-4 text-end tabular-nums">{percent(row.cacheReadShare)}</td>
                  <td className="py-2 pe-4 text-end tabular-nums">{percent(row.cacheWriteShare)}</td>
                  <td className="py-2 text-end">
                    {wastesWrites(row) && <Badge variant="warning">{t("prefixWasteBadge")}</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title={t("prefixCauses")} subtitle={t("prefixCausesDesc")}>
        <ul className="flex flex-col gap-2 text-sm">
          {summary.byCause.map((row) => (
            <li key={row.cause} className="flex items-center justify-between gap-4">
              <span>{CAUSES[row.cause] ?? row.cause}</span>
              <span className="tabular-nums text-ink-muted">{row.requests}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
