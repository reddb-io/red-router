"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import Badge, { type BadgeVariant } from "./Badge";
import Button from "./Button";

interface RecommendedPick {
  id: string;
  provider?: { name?: string };
  reason?: string;
}

interface RecommendedItem {
  name: string;
  action: "create" | "update" | "unchanged" | "blocked";
  models: string[];
  current?: string[];
}

interface RecommendedPreview {
  recommended?: Record<string, RecommendedPick | null>;
  items?: RecommendedItem[];
  toCreate?: number;
  toUpdate?: number;
}

const ROLE_KEYS = {
  default: "roleDefault",
  fast: "roleFast",
  review: "roleReview",
  vision: "roleVision",
  systemone: "roleSystemone",
} as const;

const ACTIONS: Record<RecommendedItem["action"], { key: string; variant: BadgeVariant }> = {
  create: { key: "actionCreate", variant: "success" },
  update: { key: "actionUpdate", variant: "warning" },
  unchanged: { key: "actionUnchanged", variant: "default" },
  blocked: { key: "actionBlocked", variant: "default" },
};

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

function errorText(data: Record<string, unknown>, fallback: string): string {
  return typeof data.error === "string" && data.error ? data.error : fallback;
}

/**
 * Preview and apply the combos RedRouter recommends for the connected accounts
 * (`default`, `fast`, `review`). Re-applying updates those combos in place.
 */
export default function RecommendedSetup({
  autoLoad = false,
  onApplied,
}: {
  autoLoad?: boolean;
  onApplied?: (result: unknown) => void;
}) {
  const t = useTranslations("setup");
  const [preview, setPreview] = useState<RecommendedPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  const [applied, setApplied] = useState<{ created: number; updated: number } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/combos/recommended", { cache: "no-store" });
      const data = await readJson(response);
      if (!response.ok) throw new Error(errorText(data, t("recommendedLoadFailed")));
      setPreview(data as RecommendedPreview);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t("recommendedLoadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (autoLoad) queueMicrotask(load);
  }, [autoLoad, load]);

  async function apply() {
    setApplying(true);
    setError("");
    try {
      const response = await fetch("/api/combos/recommended", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await readJson(response);
      if (!response.ok) throw new Error(errorText(data, t("recommendedApplyFailed")));
      setApplied({
        created: Number(data.createdCount) || 0,
        updated: Number(data.updatedCount) || 0,
      });
      await load();
      onApplied?.(data);
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : t("recommendedApplyFailed"));
    } finally {
      setApplying(false);
    }
  }

  if (!preview) {
    return (
      <div className="flex flex-col gap-2">
        {error ? (
          <p className="text-sm text-feedback-danger-foreground" role="alert">
            {error}
          </p>
        ) : null}
        <Button variant="secondary" size="sm" icon="auto_awesome" loading={loading} onClick={load}>
          {t("recommendedPreview")}
        </Button>
      </div>
    );
  }

  const items = preview.items || [];
  const pending = (preview.toCreate || 0) + (preview.toUpdate || 0);
  const picks = Object.entries(preview.recommended || {}).filter(
    (entry): entry is [string, RecommendedPick] => Boolean(entry[1])
  );

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {picks.length === 0 ? (
        <p className="text-sm text-text-muted">{t("recommendedConnectFirst")}</p>
      ) : (
        <dl className="grid min-w-0 gap-2 sm:grid-cols-2">
          {picks.map(([role, pick]) => (
            <div key={role} className="min-w-0 rounded-lg border border-border px-3 py-2">
              <dt className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                {role in ROLE_KEYS ? t(ROLE_KEYS[role as keyof typeof ROLE_KEYS]) : role}
              </dt>
              <dd className="min-w-0">
                <code className="block truncate font-mono text-sm text-text-main" title={pick.id}>
                  {pick.id}
                </code>
                <span className="block text-xs text-text-muted">
                  {pick.provider?.name ? `${pick.provider.name} · ` : ""}
                  {pick.reason}
                </span>
              </dd>
            </div>
          ))}
        </dl>
      )}

      {items.length > 0 ? (
        <ul className="flex min-w-0 flex-col gap-2" aria-label={t("recommendedListLabel")}>
          {items.map((item) => {
            const action = ACTIONS[item.action] || ACTIONS.unchanged;
            return (
              <li key={item.name} className="min-w-0 rounded-lg bg-bg-subtle px-3 py-2">
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <code className="truncate font-mono text-sm font-medium text-text-main">
                    {item.name}
                  </code>
                  <Badge size="sm" variant={action.variant}>
                    {t(action.key)}
                  </Badge>
                </div>
                {item.models.length > 0 ? (
                  <p className="mt-1 break-words font-mono text-xs text-text-muted">
                    {item.models.join(" → ")}
                  </p>
                ) : null}
                {item.action === "update" && item.current?.length ? (
                  <p className="mt-0.5 break-words text-[11px] text-text-muted">
                    {t("replaces")} <span className="font-mono">{item.current.join(" → ")}</span>
                  </p>
                ) : null}
                {item.action === "blocked" ? (
                  <p className="mt-0.5 text-[11px] text-text-muted">{t("blockedNote")}</p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {error ? (
        <p className="text-sm text-feedback-danger-foreground" role="alert">
          {error}
        </p>
      ) : null}
      {applied ? (
        <p className="text-sm text-text-muted" role="status">
          {applied.created || applied.updated
            ? t("appliedSummary", {
                created: applied.created,
                updated: applied.updated,
                total: applied.created + applied.updated,
              })
            : t("appliedNothing")}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          icon="auto_awesome"
          loading={applying}
          disabled={pending === 0 || loading}
          onClick={apply}
        >
          {pending === 0 ? t("applyUpToDate") : t("applyPending", { count: pending })}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon="refresh"
          loading={loading}
          disabled={applying}
          onClick={load}
        >
          {t("refresh")}
        </Button>
      </div>
    </div>
  );
}
