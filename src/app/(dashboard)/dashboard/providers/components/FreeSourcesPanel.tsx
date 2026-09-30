"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import Button from "@/shared/components/Button";
import Card from "@/shared/components/Card";
import Input from "@/shared/components/Input";
import { ConfirmModal } from "@/shared/components/Modal";
import Toggle from "@/shared/components/Toggle";
import { matchesSearch } from "@/shared/utils/turkishText";
import { providerText } from "../providerText";
import { NeutralTag } from "./NeutralTag";

export interface FreeSource {
  id: string;
  name: string;
  alias: string;
  enabled: boolean;
  hasConnection: boolean;
  kind: "connected" | "free-optin" | "available";
}

interface FreeSourcesPanelProps {
  /** Called after the server accepted a change, so the page can refresh what is enabled. */
  onChanged?: () => void;
}

const NAME_COLLATOR = new Intl.Collator("en", { sensitivity: "base", numeric: true });
const FREE_SOURCES_URL = "/api/providers/free-sources";

type FreeSourcesAction = "enable-all" | "disable-all" | "enable" | "disable";

async function requestFreeSources(body?: {
  action: FreeSourcesAction;
  providerIds?: string[];
}): Promise<{ providers: FreeSource[]; legacyUsage?: string[] }> {
  const response = await fetch(FREE_SOURCES_URL, {
    ...(body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : { cache: "no-store" }),
  });
  if (!response.ok) throw new Error(`free-sources ${response.status}`);
  const data = await response.json();
  return {
    providers: Array.isArray(data?.providers) ? data.providers : [],
    legacyUsage: Array.isArray(data?.legacyUsage) ? data.legacyUsage : undefined,
  };
}

/**
 * Free (no-key) sources. Every source is off until the operator turns it on: nothing is
 * pre-selected, "Enable all" asks for confirmation, and a source that used to serve requests is
 * only ever offered for enabling, never enabled on its own.
 */
export default function FreeSourcesPanel({ onChanged }: FreeSourcesPanelProps) {
  const t = useTranslations("providers");
  const [sources, setSources] = useState<FreeSource[] | null>(null);
  const [legacyUsage, setLegacyUsage] = useState<string[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmEnableAll, setConfirmEnableAll] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    requestFreeSources()
      .then((data) => {
        if (cancelled) return;
        setSources(data.providers);
        setLegacyUsage(data.legacyUsage ?? []);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const failureText = providerText(
    t,
    "freeSourcesUpdateFailed",
    "Could not update free sources. Nothing was changed."
  );

  const applyServerList = useCallback((providers: FreeSource[]) => {
    setSources(providers);
    const enabledIds = new Set(providers.filter((p) => p.enabled).map((p) => p.id));
    setLegacyUsage((current) => current.filter((id) => !enabledIds.has(id)));
  }, []);

  const toggleSource = async (source: FreeSource, next: boolean) => {
    if (pending.has(source.id)) return;
    setError(null);
    setPending((current) => new Set(current).add(source.id));
    // Optimistic: flip the switch now, roll back if the server refuses.
    setSources((current) =>
      current ? current.map((s) => (s.id === source.id ? { ...s, enabled: next } : s)) : current
    );
    try {
      const data = await requestFreeSources({
        action: next ? "enable" : "disable",
        providerIds: [source.id],
      });
      applyServerList(data.providers);
      onChanged?.();
    } catch {
      setSources((current) =>
        current
          ? current.map((s) => (s.id === source.id ? { ...s, enabled: source.enabled } : s))
          : current
      );
      setError(failureText);
    } finally {
      setPending((current) => {
        const rest = new Set(current);
        rest.delete(source.id);
        return rest;
      });
    }
  };

  const runBulk = async (body: { action: FreeSourcesAction; providerIds?: string[] }) => {
    if (bulkBusy) return;
    setError(null);
    setBulkBusy(true);
    try {
      const data = await requestFreeSources(body);
      applyServerList(data.providers);
      onChanged?.();
    } catch {
      setError(failureText);
    } finally {
      setBulkBusy(false);
    }
  };

  const visible = useMemo(() => {
    const needle = query.trim();
    return [...(sources ?? [])]
      .filter(
        (s) =>
          !needle ||
          matchesSearch(s.name, needle) ||
          matchesSearch(s.id, needle) ||
          matchesSearch(s.alias, needle)
      )
      .sort((a, b) => NAME_COLLATOR.compare(a.name, b.name) || (a.id < b.id ? -1 : 1));
  }, [sources, query]);

  const enabledCount = (sources ?? []).filter((s) => s.enabled).length;
  const total = sources?.length ?? 0;
  const nameById = new Map((sources ?? []).map((s) => [s.id, s.name]));
  const legacyNames = legacyUsage.map((id) => nameById.get(id) ?? id).join(", ");

  return (
    <Card padding="md">
      <div className="flex flex-col gap-4" data-testid="free-sources-panel">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-xl font-semibold text-text-main">
              {providerText(t, "freeSourcesTitle", "Free sources")}
            </h2>
            <p className="mt-1 text-sm text-text-muted">
              {providerText(
                t,
                "freeSourcesDesc",
                "Sources that need no key or account. Each one is off until you turn it on; once on, routing can send requests to it."
              )}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              icon="done_all"
              disabled={!sources || bulkBusy || total === 0}
              onClick={() => setConfirmEnableAll(true)}
              aria-label={providerText(t, "freeSourcesEnableAll", "Enable all free sources")}
            >
              {providerText(t, "freeSourcesEnableAll", "Enable all free sources")}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              icon="remove_done"
              disabled={!sources || bulkBusy || enabledCount === 0}
              onClick={() => void runBulk({ action: "disable-all" })}
              aria-label={providerText(t, "freeSourcesDisableAll", "Disable all")}
            >
              {providerText(t, "freeSourcesDisableAll", "Disable all")}
            </Button>
          </div>
        </div>

        {legacyUsage.length > 0 && (
          <div
            className="flex flex-wrap items-center gap-3 rounded-lg border border-feedback-info-border bg-feedback-info-surface px-3 py-2 text-sm text-text-main"
            data-testid="free-sources-legacy-notice"
          >
            <p className="min-w-0 flex-1">
              {providerText(
                t,
                "freeSourcesLegacyNotice",
                "These free sources handled requests in the last 90 days: {names}. They stay off until you enable them.",
                { names: legacyNames }
              )}
            </p>
            <Button
              size="sm"
              variant="secondary"
              disabled={bulkBusy}
              onClick={() => void runBulk({ action: "enable", providerIds: legacyUsage })}
            >
              {providerText(t, "freeSourcesEnableThem", "Enable them")}
            </Button>
          </div>
        )}

        {error && (
          <p
            role="alert"
            className="rounded-lg border border-feedback-danger-border bg-feedback-danger-surface px-3 py-2 text-sm text-feedback-danger-foreground"
          >
            {error}
          </p>
        )}

        {loadFailed && (
          <p role="alert" className="text-sm text-feedback-danger-foreground">
            {providerText(t, "freeSourcesLoadFailed", "Could not load free sources.")}
          </p>
        )}

        {sources === null && !loadFailed && (
          <p className="text-sm text-text-muted">
            {providerText(t, "freeSourcesLoading", "Loading free sources...")}
          </p>
        )}

        {sources && enabledCount === 0 && (
          <p
            className="rounded-lg border border-dashed border-border px-3 py-3 text-sm text-text-muted"
            data-testid="free-sources-empty"
          >
            {providerText(
              t,
              "freeSourcesNothingEnabled",
              "Nothing is enabled. Free sources are off until you turn them on."
            )}
          </p>
        )}

        {sources && total > 0 && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-[200px] flex-1">
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={providerText(t, "freeSourcesSearch", "Search free sources")}
                  aria-label={providerText(t, "freeSourcesSearch", "Search free sources")}
                  icon="search"
                />
              </div>
              <span className="text-xs text-text-muted" data-testid="free-sources-count">
                {providerText(t, "freeSourcesCount", "{enabled} of {total} enabled", {
                  enabled: enabledCount,
                  total,
                })}
              </span>
            </div>
            <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
              {visible.map((source) => (
                <li
                  key={source.id}
                  className="flex items-center gap-3 px-3 py-2"
                  data-testid={`free-source-${source.id}`}
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="truncate text-sm font-medium text-text-main">
                      {source.name}
                    </span>
                    <span className="truncate font-mono text-xs text-text-muted">{source.id}</span>
                    {source.hasConnection && (
                      <NeutralTag>{providerText(t, "connectedLabel", "Connected")}</NeutralTag>
                    )}
                  </div>
                  <Toggle
                    size="sm"
                    checked={source.enabled}
                    disabled={pending.has(source.id) || bulkBusy}
                    ariaLabel={providerText(t, "freeSourcesToggle", "Enable {name}", {
                      name: source.name,
                    })}
                    onChange={(next) => void toggleSource(source, next)}
                  />
                </li>
              ))}
              {visible.length === 0 && (
                <li className="px-3 py-3 text-sm text-text-muted">
                  {providerText(t, "noProvidersMatch", "No providers match your search.")}
                </li>
              )}
            </ul>
          </div>
        )}
      </div>

      <ConfirmModal
        isOpen={confirmEnableAll}
        onClose={() => setConfirmEnableAll(false)}
        onConfirm={async () => {
          setConfirmEnableAll(false);
          await runBulk({ action: "enable-all" });
        }}
        title={providerText(t, "freeSourcesEnableAllTitle", "Enable all free sources?")}
        message={providerText(
          t,
          "freeSourcesEnableAllMessage",
          "This turns on every free source that needs no key or account. Once enabled, routing can send requests to them, so prompts leave this machine for those third-party services. You can switch them off again at any time."
        )}
        confirmText={providerText(t, "freeSourcesEnableAllConfirm", "Enable all")}
        variant="primary"
      />
    </Card>
  );
}
