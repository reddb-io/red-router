"use client";

import { useCallback, useEffect, useState } from "react";
import Button from "./Button";
import Badge from "./Badge";

const ROLE_LABELS = {
  default: "Default",
  fast: "Fast",
  review: "Review",
  vision: "Vision",
  systemone: "System One",
};

const ACTIONS = {
  create: { label: "Create", variant: "success" },
  update: { label: "Update", variant: "warning" },
  unchanged: { label: "Up to date", variant: "default" },
  blocked: { label: "Shared name", variant: "error" },
};

/**
 * Preview and apply the combos RedRouter recommends for the connected accounts
 * (`default`, `fast`, `review`). Re-applying updates those combos in place.
 */
export default function RecommendedSetup({ autoLoad = false, onApplied }) {
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  const [applied, setApplied] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/combos/recommended", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load recommendations");
      setPreview(data);
    } catch (loadError) {
      setError(loadError.message || "Could not load recommendations");
    } finally {
      setLoading(false);
    }
  }, []);

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
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not apply the recommended setup");
      setApplied({ created: data.createdCount || 0, updated: data.updatedCount || 0 });
      await load();
      onApplied?.(data);
    } catch (applyError) {
      setError(applyError.message || "Could not apply the recommended setup");
    } finally {
      setApplying(false);
    }
  }

  if (!preview) {
    return (
      <div className="flex flex-col gap-2">
        {error ? <p className="text-sm text-[var(--reddb-color-feedback-danger-foreground)]" role="alert">{error}</p> : null}
        <Button variant="secondary" size="sm" icon="auto_awesome" loading={loading} onClick={load}>
          Preview recommended setup
        </Button>
      </div>
    );
  }

  const items = preview.items || [];
  const pending = (preview.toCreate || 0) + (preview.toUpdate || 0);
  const picks = Object.entries(preview.recommended || {}).filter(([, pick]) => pick);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {picks.length === 0 ? (
        <p className="text-sm text-text-muted">Connect a provider first: recommendations come from your connected accounts.</p>
      ) : (
        <dl className="grid min-w-0 gap-2 sm:grid-cols-2">
          {picks.map(([role, pick]) => (
            <div key={role} className="min-w-0 rounded-lg border border-muted px-3 py-2">
              <dt className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">{ROLE_LABELS[role] || role}</dt>
              <dd className="min-w-0">
                <code className="block truncate font-mono text-sm text-text-main" title={pick.id}>{pick.id}</code>
                <span className="block text-xs text-text-muted">{pick.provider?.name ? `${pick.provider.name} · ` : ""}{pick.reason}</span>
              </dd>
            </div>
          ))}
        </dl>
      )}

      {items.length > 0 ? (
        <ul className="flex min-w-0 flex-col gap-2" aria-label="Recommended combos">
          {items.map((item) => {
            const action = ACTIONS[item.action] || ACTIONS.unchanged;
            return (
              <li key={item.name} className="min-w-0 rounded-lg bg-muted/50 px-3 py-2">
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <code className="truncate font-mono text-sm font-medium">{item.name}</code>
                  <Badge size="sm" variant={action.variant}>{action.label}</Badge>
                </div>
                <p className="mt-1 break-words font-mono text-xs text-text-muted">{item.models.join(" → ")}</p>
                {item.action === "update" && item.current?.length ? (
                  <p className="mt-0.5 break-words text-[11px] text-text-muted">Replaces: <span className="font-mono">{item.current.join(" → ")}</span></p>
                ) : null}
                {item.action === "blocked" ? (
                  <p className="mt-0.5 text-[11px] text-text-muted">A shared combo already uses this name. Hide it on the Combos page to use the recommendation.</p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {error ? <p className="text-sm text-[var(--reddb-color-feedback-danger-foreground)]" role="alert">{error}</p> : null}
      {applied ? (
        <p className="text-sm text-text-muted" role="status">
          {applied.created || applied.updated
            ? `Created ${applied.created}, updated ${applied.updated} combo${applied.created + applied.updated === 1 ? "" : "s"}.`
            : "Nothing to change."}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" icon="auto_awesome" loading={applying} disabled={pending === 0 || loading} onClick={apply}>
          {pending === 0 ? "Combos up to date" : `Apply (${pending})`}
        </Button>
        <Button variant="ghost" size="sm" icon="refresh" loading={loading} disabled={applying} onClick={load}>
          Refresh
        </Button>
      </div>
    </div>
  );
}
