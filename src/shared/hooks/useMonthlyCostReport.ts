"use client";

import { useEffect, useState } from "react";
import type { MonthlyCostReport } from "@/lib/db/monthlyCostReport";

export function useMonthlyCostReport(
  month: string,
  tenantId?: string,
  apiKeyIds: readonly string[] = []
) {
  const [retry, setRetry] = useState(0);
  const query = new URLSearchParams({ month });
  if (tenantId) query.set("tenantId", tenantId);
  for (const id of [...new Set(apiKeyIds)].sort()) query.append("apiKeyId", id);
  const url = `/api/usage/monthly-report?${query.toString()}`;
  const stamp = `${url}:${retry}`;
  const [result, setResult] = useState<{
    stamp: string;
    report?: MonthlyCostReport;
    error?: string;
  } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error("Unable to load monthly usage. Try again.");
        const data = (await response.json()) as { report: MonthlyCostReport };
        if (!data.report || data.report.month !== month || !Array.isArray(data.report.keys)) {
          throw new Error("Invalid monthly usage response.");
        }
        if (!controller.signal.aborted) setResult({ stamp, report: data.report });
      } catch {
        if (!controller.signal.aborted)
          setResult({ stamp, error: "Unable to load monthly usage. Try again." });
      }
    })();
    return () => controller.abort();
  }, [url, stamp, month]);
  const current = result?.stamp === stamp ? result : null;
  return {
    report: current?.report ?? null,
    error: current?.error ?? null,
    loading: !current,
    reload: () => setRetry((value) => value + 1),
  };
}
