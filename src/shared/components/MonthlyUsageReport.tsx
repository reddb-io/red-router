"use client";

import { useId, useState } from "react";
import { useMonthlyCostReport } from "@/shared/hooks/useMonthlyCostReport";
import { isReportingMonth } from "@/lib/usage/reportingMonth";
import Button from "./Button";
import Input from "./Input";
import type { MonthlyCostReport, MonthlyUsageTotals } from "@/lib/db/monthlyCostReport";

const number = (value: number) => value.toLocaleString("en-US");
export const recordedMoney = (value: number | null) =>
  value === null
    ? "Not recorded"
    : value.toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 4,
        maximumFractionDigits: 6,
      });

export function MonthlyUsageReportView({
  month,
  onMonthChange,
  report,
  loading,
  error,
  onRetry,
  showTenants = true,
}: {
  month: string;
  onMonthChange: (value: string) => void;
  report: MonthlyCostReport | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  showTenants?: boolean;
}) {
  const id = useId();
  const cells = (row: MonthlyUsageTotals) => [
    number(row.requests),
    number(row.errors),
    number(row.inputTokens + row.outputTokens),
    recordedMoney(row.recordedCostUsd),
    number(row.ledgerEntries),
  ];
  return (
    <section className="flex min-w-0 flex-col gap-3" aria-labelledby={id}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 id={id} className="text-sm font-semibold text-text-main">
            Monthly recorded usage
          </h3>
          <p className="text-xs text-text-muted">
            Same UTC calendar month and sources in Keys, Costs and Tenants.
          </p>
        </div>
        <Input
          label="Usage month (UTC)"
          type="month"
          value={month}
          min="2000-01"
          max="9998-12"
          onChange={(event) => onMonthChange(event.target.value)}
        />
      </div>
      {loading ? (
        <p role="status" className="text-sm text-text-muted">
          Loading monthly usage…
        </p>
      ) : error ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 text-sm text-feedback-danger-foreground"
        >
          <p>{error}</p>
          <Button onClick={onRetry}>Retry monthly usage</Button>
        </div>
      ) : report ? (
        <>
          <p className="text-xs text-text-muted">
            {report.since} ≤ event time &lt; {report.until}. Requests: retained history. Amounts:
            recorded cost entries.
          </p>
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-left text-xs">
              <caption className="sr-only">Monthly usage by key for {month}, UTC</caption>
              <thead>
                <tr className="border-b border-border text-text-muted">
                  {[
                    ...(showTenants ? ["Tenant"] : []),
                    "API key",
                    "Requests",
                    "Errors",
                    "Tokens",
                    "Recorded amount (USD)",
                    "Cost entries",
                  ].map((label) => (
                    <th key={label} className="whitespace-nowrap px-3 py-2 font-medium">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.keys.map((row) => (
                  <tr
                    key={JSON.stringify([row.tenantId, row.apiKeyId])}
                    className="border-b border-border last:border-0 text-text-main"
                  >
                    {showTenants && <td className="px-3 py-2">{row.tenantName}</td>}
                    <td className="px-3 py-2">
                      <span>{row.name}</span>
                      {row.apiKeyId && (
                        <span className="block text-text-muted" title={row.apiKeyId}>
                          {row.apiKeyId}
                        </span>
                      )}
                      {!row.current && row.apiKeyId && (
                        <span className="block text-text-muted">Historical tenant assignment</span>
                      )}
                    </td>
                    {cells(row).map((value, index) => (
                      <td key={index} className="whitespace-nowrap px-3 py-2 tabular-nums">
                        {value}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-border font-medium text-text-main">
                  <th colSpan={showTenants ? 2 : 1} className="px-3 py-2">
                    {showTenants ? "Selected total" : "Tenant total"}
                  </th>
                  {cells(report.total).map((value, index) => (
                    <td key={index} className="whitespace-nowrap px-3 py-2 tabular-nums">
                      {value}
                    </td>
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>
          {report.total.requests === 0 && (
            <p className="text-xs text-text-muted">
              No retained requests for this month. Cost entries can still exist independently.
            </p>
          )}
          <p className="max-w-3xl text-xs text-text-muted">{report.coverage}</p>
        </>
      ) : null}
    </section>
  );
}

export default function MonthlyUsageReport({
  tenantId,
  apiKeyIds,
  initialMonth,
}: {
  tenantId?: string;
  apiKeyIds?: readonly string[];
  initialMonth?: string | null;
}) {
  const [month, setMonth] = useState(
    initialMonth && isReportingMonth(initialMonth)
      ? initialMonth
      : new Date().toISOString().slice(0, 7)
  );
  const state = useMonthlyCostReport(month, tenantId, apiKeyIds);
  return (
    <MonthlyUsageReportView
      month={month}
      onMonthChange={setMonth}
      {...state}
      onRetry={state.reload}
      showTenants={!tenantId}
    />
  );
}
