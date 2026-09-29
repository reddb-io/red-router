"use client";

import { useTranslations } from "next-intl";
import { Badge } from "@/shared/components";
import type { TestResult } from "../types";

/** The outcome of "Send test", in the DS feedback roles. */
export function TestResultPanel({ result }: { result: TestResult | null }) {
  const t = useTranslations("usageSinks");
  if (!result) return null;
  const probe = result.probe;
  const tone = result.valid
    ? "border-feedback-success-border bg-feedback-success-surface text-feedback-success-foreground"
    : "border-feedback-danger-border bg-feedback-danger-surface text-feedback-danger-foreground";
  return (
    <div className={`rounded-md border px-3 py-2 text-xs ${tone}`} role="status">
      <div className="flex flex-wrap items-center gap-2">
        <Badge size="sm" variant={result.valid ? "success" : "danger"}>
          {result.valid ? t("testDelivered") : t("testFailed")}
        </Badge>
        {probe?.status != null ? (
          <span className="font-mono">
            {probe.status}
            {probe.statusText ? ` ${probe.statusText}` : ""}
          </span>
        ) : probe?.statusText ? (
          <span className="font-mono">{probe.statusText}</span>
        ) : null}
        {typeof result.latencyMs === "number" ? <span>{result.latencyMs} ms</span> : null}
        {probe?.url ? <span className="min-w-0 truncate font-mono">{probe.url}</span> : null}
      </div>
      {result.error ? <p className="mt-1 break-words">{result.error}</p> : null}
      {result.valid ? <p className="mt-1">{t("testSampleNote")}</p> : null}
    </div>
  );
}
