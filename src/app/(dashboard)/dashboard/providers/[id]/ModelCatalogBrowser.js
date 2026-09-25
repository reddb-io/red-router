"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/shared/utils/cn";
import {
  CAPABILITY_FLAGS,
  CONTEXT_OPTIONS,
  PRESETS,
  RELEASED_OPTIONS,
  SORT_OPTIONS,
  catalogSourceLabel,
  filterModels,
  formatCost,
  formatTokens,
  isOfflineCatalog,
  presetFilters,
  vendorFacets,
} from "@/shared/utils/modelBrowser";
import Icon from "@/shared/components/Icon";

const PAGE_SIZE = 12;

const selectClass = "rounded-lg border border-muted bg-surface-2 px-2 py-1.5 text-xs text-text-main focus:outline-none focus:ring-2 focus:ring-primary/30";

function chipClass(active) {
  return cn(
    "flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors",
    active
      ? "border-primary/50 bg-primary/10 text-primary"
      : "border-muted text-text-muted hover:border-primary/40 hover:text-primary"
  );
}

function Capability({ on, icon, label }) {
  if (!on) return null;
  return (
    <span title={label} className="inline-flex text-text-muted">
      <Icon name={icon} size={14} label={label} />
    </span>
  );
}

/**
 * Every model the provider serves (models.dev, plus the live list of providers
 * that publish one: OpenRouter, OpenCode Zen, OpenCode Go),
 * filterable by name, owner, context, release date and capabilities, with
 * one-click presets. Calls onAdd(ids) to add models to the provider.
 * Renders nothing when there is no catalog for this provider (onEmpty then fires).
 */
export default function ModelCatalogBrowser({ providerId, addedIds, onAdd, onEmpty }) {
  const [catalog, setCatalog] = useState(null);
  const [loading, setLoading] = useState(true);
  const [preset, setPreset] = useState("recommended");
  const [filters, setFilters] = useState(() => presetFilters("recommended"));
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [selected, setSelected] = useState(() => new Set());
  const [adding, setAdding] = useState(false);
  const [hideAdded, setHideAdded] = useState(true);

  // The page remounts this per provider (key), so one fetch per mount is enough.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/models/browse?provider=${encodeURIComponent(providerId)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled) return;
        setCatalog(data);
        if (!data?.models?.length) { onEmpty?.(); return; }
        // A small or older catalog can leave "Recommended" empty: open on the newest instead.
        if (filterModels(data.models, presetFilters("recommended")).every((m) => addedIds.has(m.id))) {
          setPreset("newest");
          setFilters(presetFilters("newest"));
        }
      })
      .catch(() => { if (!cancelled) { setCatalog(null); onEmpty?.(); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId]);

  const all = useMemo(() => catalog?.models || [], [catalog]);
  const vendors = useMemo(() => vendorFacets(all), [all]);
  const matches = useMemo(() => filterModels(all, filters), [all, filters]);
  const visible = useMemo(
    () => (hideAdded ? matches.filter((m) => !addedIds.has(m.id)) : matches),
    [matches, hideAdded, addedIds]
  );
  const addedCount = matches.length - (hideAdded ? visible.length : matches.filter((m) => !addedIds.has(m.id)).length);

  if (loading) {
    return (
      <div className="w-full mt-3 rounded-lg border border-muted p-3 text-xs text-text-muted">
        Loading the model catalog…
      </div>
    );
  }
  if (!all.length) return null;

  const update = (patch) => {
    setPreset(null);
    setLimit(PAGE_SIZE);
    setFilters((prev) => ({ ...prev, ...patch }));
  };
  const applyPreset = (id) => {
    setPreset(id);
    setLimit(PAGE_SIZE);
    setFilters((prev) => ({ ...presetFilters(id), query: prev.query }));
  };
  const toggleFlag = (key) => update({ flags: { ...filters.flags, [key]: !filters.flags?.[key] } });
  const toggleSelected = (id) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const add = async (ids) => {
    if (adding || ids.length === 0) return;
    setAdding(true);
    try {
      await onAdd(ids);
      setSelected((prev) => { const next = new Set(prev); ids.forEach((id) => next.delete(id)); return next; });
    } finally {
      setAdding(false);
    }
  };

  const shown = visible.slice(0, limit);
  const selectedIds = [...selected].filter((id) => !addedIds.has(id));

  return (
    <div className="w-full mt-3 rounded-lg border border-muted">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-muted px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Icon name="travel_explore" size={18} className="text-primary" />
          <div>
            <p className="text-sm font-medium text-text-main">Discover models</p>
            <p className="text-[11px] text-text-muted">
              {all.length} models in the catalog · source: {catalogSourceLabel(catalog.source)}
              {catalog.fetchedAt && isOfflineCatalog(catalog.source) && ` · offline, as of ${new Date(catalog.fetchedAt).toLocaleDateString()}`}
            </p>
          </div>
        </div>
        {selectedIds.length > 0 && (
          <button
            onClick={() => add(selectedIds)}
            disabled={adding}
            className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            <Icon name={adding ? "progress_activity" : "playlist_add"} size={14} />
            Add {selectedIds.length} selected
          </button>
        )}
      </div>

      <div className="flex flex-col gap-2.5 p-3">
        {/* Presets */}
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <button key={p.id} onClick={() => applyPreset(p.id)} className={chipClass(preset === p.id)}>
              <Icon name={p.icon} size={14} />
              {p.label}
            </button>
          ))}
        </div>

        {/* Search + filters */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[180px] flex-1">
            <Icon name="search" size={16} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              value={filters.query}
              onChange={(e) => { setLimit(PAGE_SIZE); setFilters((prev) => ({ ...prev, query: e.target.value })); }}
              placeholder="Search by name, id or owner…"
              className={cn(selectClass, "w-full pl-7")}
            />
          </div>
          <select value={filters.vendor} onChange={(e) => update({ vendor: e.target.value })} className={selectClass} aria-label="Owner">
            <option value="">All owners</option>
            {vendors.map((v) => <option key={v.vendor} value={v.vendor}>{v.vendor} ({v.count})</option>)}
          </select>
          <select value={filters.minContext} onChange={(e) => update({ minContext: Number(e.target.value) })} className={selectClass} aria-label="Context">
            {CONTEXT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <select value={filters.releasedWithinDays} onChange={(e) => update({ releasedWithinDays: Number(e.target.value) })} className={selectClass} aria-label="Released">
            {RELEASED_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <select value={filters.sort} onChange={(e) => update({ sort: e.target.value })} className={selectClass} aria-label="Sort">
            {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>Sort: {o.label}</option>)}
          </select>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {CAPABILITY_FLAGS.map((f) => (
            <button key={f.key} onClick={() => toggleFlag(f.key)} className={chipClass(!!filters.flags?.[f.key])}>
              <Icon name={filters.flags?.[f.key] ? "check" : f.icon} size={14} />
              {f.label}
            </button>
          ))}
          <span className="ml-auto text-[11px] text-text-muted">
            {visible.length} match{visible.length === 1 ? "" : "es"}
            {addedCount > 0 && (
              <button onClick={() => setHideAdded((v) => !v)} className="ml-1.5 underline hover:text-primary">
                {hideAdded ? `+${addedCount} already added` : "hide added"}
              </button>
            )}
          </span>
        </div>

        {/* Results */}
        {shown.length === 0 ? (
          <p className="py-4 text-center text-xs text-text-muted">No model matches these filters.</p>
        ) : (
          <ul className="divide-y divide-muted rounded-lg border border-muted">
            {shown.map((m) => {
              const isAdded = addedIds.has(m.id);
              const cost = formatCost(m);
              const ctx = formatTokens(m.contextWindow);
              return (
                <li key={m.id} className="flex items-center gap-2.5 px-2.5 py-2 hover:bg-muted/50">
                  <input
                    type="checkbox"
                    checked={isAdded || selected.has(m.id)}
                    disabled={isAdded || m.decision}
                    onChange={() => toggleSelected(m.id)}
                    aria-label={`Select ${m.name}`}
                    className="size-3.5 accent-primary"
                  />
                  <div className="min-w-0 flex-1" title={m.description || undefined}>
                    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                      <span className="truncate text-xs font-medium text-text-main">{m.name}</span>
                      {m.decision && (
                        <span
                          className="rounded border border-feedback-info-border bg-feedback-info-surface px-1 text-[10px] font-medium text-feedback-info-foreground"
                          title="A System One decision model: it returns a typed choice through /v1/systemone, not a chat reply"
                        >
                          System One
                        </span>
                      )}
                      <Capability on={m.reasoning} icon="psychology" label="Reasoning" />
                      <Capability on={m.tools} icon="build" label="Tool calling" />
                      <Capability on={m.vision} icon="image" label="Image input" />
                      <Capability on={m.pdf} icon="picture_as_pdf" label="PDF input" />
                      <Capability on={m.audio} icon="mic" label="Audio input" />
                      <Capability on={m.openWeights} icon="lock_open" label="Open weights" />
                    </div>
                    <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-text-muted">
                      <code className="truncate">{m.id}</code>
                      {m.vendor && <span>· {m.vendor}</span>}
                      {m.releaseDate && <span>· {m.releaseDate}</span>}
                    </div>
                  </div>
                  <div className="hidden shrink-0 text-right text-[11px] text-text-muted sm:block">
                    {ctx && <div>{ctx} ctx</div>}
                    {cost && <div className={m.free ? "text-feedback-success-foreground" : undefined}>{cost}</div>}
                  </div>
                  {m.decision ? (
                    // Not a chat model: adding it to this provider's chat models would never work.
                    <Link
                      href="/dashboard/tools-providers/systemone"
                      className="flex shrink-0 items-center gap-0.5 rounded-md border border-muted px-2 py-1 text-[11px] text-foreground hover:bg-muted/50"
                    >
                      <Icon name="arrow_forward" size={14} />Use in System One
                    </Link>
                  ) : isAdded ? (
                    <span className="flex shrink-0 items-center gap-0.5 text-[11px] text-feedback-success-foreground">
                      <Icon name="check" size={14} />Added
                    </span>
                  ) : (
                    <button
                      onClick={() => add([m.id])}
                      disabled={adding}
                      className="flex shrink-0 items-center gap-0.5 rounded-md border border-primary/30 px-2 py-1 text-[11px] text-primary hover:bg-primary/5 disabled:opacity-50"
                    >
                      <Icon name="add" size={14} />Add
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {visible.length > limit && (
          <button onClick={() => setLimit((n) => n + PAGE_SIZE * 2)} className="self-center text-xs text-primary hover:underline">
            Show more ({visible.length - limit} left)
          </button>
        )}
        <p className="text-[10px] text-text-muted">
          Prices in USD per million tokens (input / output). The catalog refreshes daily; a model listed here may still need access on your account.
        </p>
      </div>
    </div>
  );
}
