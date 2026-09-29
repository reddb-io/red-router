"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Badge, Button, Select } from "@/shared/components";
import { errorText, type Delivery } from "../types";

const PAGE_SIZE = 10;

const formatCost = (value: number) => `$${value.toFixed(value < 1 ? 4 : 2)}`;
const formatTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "-");

interface DeliveriesPanelProps {
  sinkId: string;
  /** Called after a retry so the card's counters refresh. */
  onChange: () => void;
}

const STATUS_VARIANT = {
  delivered: "success",
  dead: "danger",
  pending: "warning",
  sending: "warning",
} as const;

export function DeliveriesPanel({ sinkId, onChange }: DeliveriesPanelProps) {
  const t = useTranslations("usageSinks");
  const [deliveries, setDeliveries] = useState<Delivery[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [retrying, setRetrying] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const query = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (status) query.set("status", status);
    const res = await fetch(`/api/usage-sinks/${sinkId}/deliveries?${query}`);
    const data = await res.json().catch(() => ({}));
    setDeliveries(Array.isArray(data.deliveries) ? data.deliveries : []);
    setTotal(typeof data.total === "number" ? data.total : 0);
  }, [sinkId, page, status]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const retry = async (delivery: Delivery) => {
    setRetrying(delivery.id);
    setNotice(null);
    try {
      const res = await fetch(`/api/usage-sinks/${sinkId}/deliveries/${delivery.id}/retry`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setNotice(errorText(data, t("retryFailed")));
      else if (!data.ok) setNotice(data.error || t("retryFailed"));
      await load();
      onChange();
    } finally {
      setRetrying(null);
    }
  };

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <Select
          label={t("deliveryStatus")}
          value={status}
          onChange={(event) => {
            setPage(1);
            setStatus(event.target.value);
          }}
          options={[
            { value: "", label: t("statusAll") },
            { value: "pending", label: t("statusPending") },
            { value: "delivered", label: t("statusDelivered") },
            { value: "failed", label: t("statusFailed") },
          ]}
          className="w-44"
        />
        <Button size="sm" variant="ghost" icon="refresh" onClick={() => void load()}>
          {t("refresh")}
        </Button>
      </div>
      {notice ? (
        <p
          className="rounded-md border border-feedback-danger-border bg-feedback-danger-surface px-3 py-2 text-xs text-feedback-danger-foreground"
          role="alert"
        >
          {notice}
        </p>
      ) : null}
      {deliveries === null ? (
        <p className="text-xs text-text-muted">{t("loadingDeliveries")}</p>
      ) : deliveries.length === 0 ? (
        <p className="text-xs text-text-muted">{t("noDeliveries")}</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-left text-xs">
            <thead className="text-text-muted">
              <tr className="border-b border-border">
                <th className="px-3 py-2 font-medium">{t("colCreated")}</th>
                <th className="px-3 py-2 font-medium">{t("colCovers")}</th>
                <th className="px-3 py-2 font-medium">{t("colRequests")}</th>
                <th className="px-3 py-2 font-medium">{t("colCost")}</th>
                <th className="px-3 py-2 font-medium">{t("colStatus")}</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {deliveries.map((delivery) => (
                <tr key={delivery.id} className="border-b border-border align-top last:border-0">
                  <td className="whitespace-nowrap px-3 py-2 text-text-main">
                    {formatTime(delivery.createdAt)}
                  </td>
                  <td className="px-3 py-2 text-text-main">
                    {delivery.kind === "window"
                      ? `${formatTime(delivery.windowStart)} - ${
                          delivery.windowEnd
                            ? new Date(delivery.windowEnd).toLocaleTimeString()
                            : "-"
                        }`
                      : delivery.model || t("oneRequest")}
                    <div className="font-mono text-[11px] text-text-muted">{delivery.id}</div>
                  </td>
                  <td className="px-3 py-2 font-mono tabular-nums text-text-main">
                    {delivery.requests}
                    {delivery.kind === "window"
                      ? ` · ${t("keysCount", { count: delivery.keys })}`
                      : ""}
                  </td>
                  <td className="px-3 py-2 font-mono tabular-nums text-text-main">
                    {formatCost(delivery.cost)}
                  </td>
                  <td className="px-3 py-2">
                    <Badge size="sm" variant={STATUS_VARIANT[delivery.status]}>
                      {delivery.status === "dead" ? t("statusFailed") : delivery.status}
                      {delivery.lastStatus ? ` · ${delivery.lastStatus}` : ""}
                    </Badge>
                    <div className="mt-1 text-text-muted">
                      {t("attempts", { count: delivery.attempts })}
                      {delivery.status === "pending" && delivery.nextAttemptAt
                        ? ` · ${t("nextAttempt", {
                            time: new Date(delivery.nextAttemptAt).toLocaleTimeString(),
                          })}`
                        : ""}
                    </div>
                    {delivery.lastError && delivery.status !== "delivered" ? (
                      <div className="mt-1 max-w-xs break-words text-feedback-danger-foreground">
                        {delivery.lastError}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {delivery.status !== "delivered" ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={retrying === delivery.id}
                        onClick={() => void retry(delivery)}
                      >
                        {t("retryNow")}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pages > 1 ? (
        <div className="flex items-center justify-between gap-2 text-xs text-text-muted">
          <span>{t("pageOf", { page, pages, total })}</span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              {t("previous")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={page >= pages}
              onClick={() => setPage(page + 1)}
            >
              {t("next")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
