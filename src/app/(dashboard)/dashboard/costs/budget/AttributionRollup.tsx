"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Loading, Select } from "@/shared/components";
import { errorText, formatUsd, type AttributionRow } from "./budgetsTypes";

type Dimension = "tag" | "user";
const PERIODS = [7, 30, 90] as const;

/**
 * Read-only "Spend by tag / end user": metered spend and request count of attributed traffic.
 * Tags and end users are client-supplied text; they are rendered as React text only (escaped),
 * truncated with the full value in the title.
 */
export default function AttributionRollup() {
  const t = useTranslations("budgets");
  const [by, setBy] = useState<Dimension>("tag");
  const [days, setDays] = useState<number>(30);
  const [rows, setRows] = useState<AttributionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/usage/attribution?by=${by}&days=${days}`);
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) throw new Error(errorText(data, t("attrLoadFailed")));
        setRows(Array.isArray(data.rows) ? data.rows : []);
        setError(null);
      } catch (failure) {
        if (!cancelled) {
          setRows([]);
          setError(failure instanceof Error ? failure.message : t("attrLoadFailed"));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [by, days, t]);

  return (
    <section className="flex min-w-0 flex-col gap-3" aria-labelledby="budget-attribution-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="max-w-2xl">
          <h2 id="budget-attribution-title" className="text-lg font-semibold text-text-main">
            {t("attrTitle")}
          </h2>
          <p className="text-xs text-text-muted">{t("attrIntro")}</p>
        </div>
        <div className="flex gap-3">
          <Select
            label={t("attrBy")}
            value={by}
            onChange={(event) => setBy(event.target.value === "user" ? "user" : "tag")}
            options={[
              { value: "tag", label: t("attrByTag") },
              { value: "user", label: t("attrByUser") },
            ]}
          />
          <Select
            label={t("attrPeriod")}
            value={String(days)}
            onChange={(event) => setDays(Number(event.target.value))}
            options={PERIODS.map((value) => ({
              value: String(value),
              label: t("attrDays", { days: value }),
            }))}
          />
        </div>
      </div>

      {error ? (
        <p
          className="rounded-md border border-feedback-danger-border bg-feedback-danger-surface px-3 py-2 text-xs text-feedback-danger-foreground"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {loading ? (
        <Loading />
      ) : rows.length === 0 && !error ? (
        <p className="rounded-md border border-border px-3 py-6 text-center text-sm text-text-muted">
          {t("attrEmpty")}
        </p>
      ) : rows.length > 0 ? (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-left text-xs">
            <thead className="text-text-muted">
              <tr className="border-b border-border">
                <th className="px-3 py-2 font-medium">
                  {by === "tag" ? t("attrByTag") : t("attrByUser")}
                </th>
                <th className="px-3 py-2 text-right font-medium">{t("attrColRequests")}</th>
                <th className="px-3 py-2 text-right font-medium">{t("attrColSpend")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className="border-b border-border last:border-0">
                  <td className="max-w-80 truncate px-3 py-2 text-text-main" title={row.key}>
                    {row.key}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-text-main">
                    {row.requestCount.toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-text-main">
                    {formatUsd(row.amountUsd)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
