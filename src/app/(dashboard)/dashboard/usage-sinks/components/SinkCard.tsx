"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Badge, Button, Card, Toggle } from "@/shared/components";
import type { TestResult, UsageSink } from "../types";
import { DeliveriesPanel } from "./DeliveriesPanel";
import { TestResultPanel } from "./TestResultPanel";

interface SinkCardProps {
  sink: UsageSink;
  testResult: TestResult | null;
  testing: boolean;
  onToggle: (enabled: boolean) => void;
  onTest: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onChange: () => void;
}

export function SinkCard({
  sink,
  testResult,
  testing,
  onToggle,
  onTest,
  onEdit,
  onDelete,
  onChange,
}: SinkCardProps) {
  const t = useTranslations("usageSinks");
  const [showDeliveries, setShowDeliveries] = useState(false);

  const modeLabel =
    sink.mode === "instant"
      ? t("modeInstantShort")
      : t("windowEvery", { minutes: (sink.windowSec ?? 900) / 60 });
  const names = sink.filterKeys.map((key) => key.name || t("deletedKey"));
  const scope =
    names.length === 0
      ? t("allKeys")
      : names.length > 3
        ? `${names.slice(0, 3).join(", ")} +${names.length - 3}`
        : names.join(", ");

  return (
    <Card padding="sm">
      <div className="flex flex-col gap-3">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate text-sm font-semibold text-text-main">{sink.name}</h3>
              <Badge size="sm" variant="primary">
                {sink.typeLabel}
              </Badge>
              <Badge size="sm" variant={sink.enabled ? "success" : "default"} dot>
                {sink.enabled ? t("active") : t("paused")}
              </Badge>
              <Badge size="sm">{modeLabel}</Badge>
            </div>
            <p className="mt-1 truncate font-mono text-xs text-text-muted" title={sink.summary}>
              {sink.summary}
            </p>
            <p className="mt-0.5 text-xs text-text-muted">{scope}</p>
          </div>
          <Toggle
            checked={sink.enabled}
            onChange={onToggle}
            ariaLabel={t("toggleSink", { name: sink.name })}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge size="sm" variant="success">
            {t("deliveredCount", { count: sink.deliveries.delivered })}
          </Badge>
          {sink.deliveries.pending > 0 ? (
            <Badge size="sm" variant="warning">
              {t("pendingCount", { count: sink.deliveries.pending })}
            </Badge>
          ) : null}
          {sink.deliveries.dead > 0 ? (
            <Badge size="sm" variant="danger">
              {t("failedCount", { count: sink.deliveries.dead })}
            </Badge>
          ) : null}
          <div className="ml-auto flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" icon="send" loading={testing} onClick={onTest}>
              {t("sendTest")}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              icon="list"
              onClick={() => setShowDeliveries(!showDeliveries)}
            >
              {t("deliveries")}
            </Button>
            <Button size="sm" variant="ghost" icon="edit" onClick={onEdit}>
              {t("edit")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon="delete"
              onClick={onDelete}
              aria-label={t("deleteSink", { name: sink.name })}
            />
          </div>
        </div>

        <TestResultPanel result={testResult} />
        {showDeliveries ? <DeliveriesPanel sinkId={sink.id} onChange={onChange} /> : null}
      </div>
    </Card>
  );
}
