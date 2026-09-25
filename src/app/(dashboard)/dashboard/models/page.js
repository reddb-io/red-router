"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, Button, Badge, Input, SegmentedControl, Toggle, Icon } from "@/shared/components";

// Models: one entry per flat model id (vendor/model), with every offer that can
// serve it. The order here is the fallback order a flat id routes in; a
// switched-off offer is skipped by the flat id (its full id still works).
const FILTERS = [
  { value: "several", label: "Several offers" },
  { value: "all", label: "All" },
  { value: "custom", label: "Customized" },
];

const formatPrice = (price) => {
  if (!price) return null;
  const fmt = (n) => (typeof n === "number" ? `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}` : "?");
  return `${fmt(price.input)} in · ${fmt(price.output)} out / 1M`;
};

async function fetchModels() {
  const res = await fetch("/api/flat-models", { cache: "no-store" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data.models || [];
}

function routeLabel(offer) {
  const hops = (offer.via || []).map((hop) => hop.name || hop.slug);
  return [...hops, offer.provider?.name || offer.provider?.id].filter(Boolean).join(" › ");
}

function ModelRow({ model, onSaved }) {
  const [open, setOpen] = useState(false);
  const [offers, setOffers] = useState(model.offers);
  const [saved, setSaved] = useState(model.offers);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Reloaded after a save: start over from what is saved now.
  if (saved !== model.offers) {
    setSaved(model.offers);
    setOffers(model.offers);
  }

  const dirty = offers.some((o, i) => o.id !== model.offers[i]?.id || o.available !== model.offers[i]?.available);
  const serving = offers.find((o) => o.available);

  const move = (index, delta) => {
    const next = [...offers];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setOffers(next);
  };
  const toggle = (id) => setOffers(offers.map((o) => (o.id === id ? { ...o, available: !o.available } : o)));

  async function send(method, body) {
    setSaving(true);
    setError("");
    try {
      const url = method === "DELETE" ? `/api/flat-models?key=${encodeURIComponent(model.key)}` : "/api/flat-models";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      await onSaved();
    } catch (e) {
      setError(`Could not save: ${e.message}`);
    } finally {
      setSaving(false);
    }
  }

  const save = () => send("PUT", {
    key: model.key,
    order: offers.map((o) => o.id),
    disabled: offers.filter((o) => !o.available).map((o) => o.id),
  });
  const reset = () => send("DELETE");

  return (
    <Card padding="none" className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-surface-2 transition-colors"
      >
        <Icon name={open ? "expand_more" : "chevron_right"} size={18} className="text-text-muted shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-sm truncate" data-i18n-skip="true">{model.id}</p>
          <p className="text-xs text-text-muted truncate">
            {serving ? <>First: <span data-i18n-skip="true">{routeLabel(serving)}</span></> : "Every offer is switched off"}
          </p>
        </div>
        {model.offer_order === "custom" && <Badge variant="info" size="sm">Custom order</Badge>}
        <Badge variant="neutral" size="sm">{model.offers.length} {model.offers.length === 1 ? "offer" : "offers"}</Badge>
      </button>

      {open && (
        <div className="border-t border-border px-4 py-3 flex flex-col gap-3">
          <ol className="flex flex-col gap-2">
            {offers.map((offer, index) => (
              <li
                key={offer.id}
                className={`flex items-center gap-3 p-2.5 rounded-lg border border-border bg-bg ${offer.available ? "" : "opacity-60"}`}
              >
                <span className="w-5 text-center text-xs text-text-muted tabular-nums">{index + 1}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate" data-i18n-skip="true">{routeLabel(offer)}</p>
                  <p className="text-xs text-text-muted truncate" data-i18n-skip="true">
                    {offer.id}
                    {formatPrice(offer.price) ? ` · ${formatPrice(offer.price)}` : ""}
                  </p>
                </div>
                {offer.free && <Badge variant="success" size="sm">Free</Badge>}
                <div className="flex items-center">
                  <Button variant="ghost" size="sm" icon="arrow_upward" aria-label="Move up" disabled={index === 0} onClick={() => move(index, -1)} />
                  <Button variant="ghost" size="sm" icon="arrow_downward" aria-label="Move down" disabled={index === offers.length - 1} onClick={() => move(index, 1)} />
                </div>
                <Toggle checked={offer.available} onChange={() => toggle(offer.id)} size="sm" />
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" size="sm" onClick={save} loading={saving} disabled={!dirty || saving}>Save</Button>
            {dirty && <Button variant="ghost" size="sm" onClick={() => setOffers(model.offers)} disabled={saving}>Discard</Button>}
            {model.policy && !dirty && (
              <Button variant="secondary" size="sm" onClick={reset} loading={saving}>Back to cheapest first</Button>
            )}
            {error && <p className="text-xs text-feedback-danger-foreground">{error}</p>}
          </div>
        </div>
      )}
    </Card>
  );
}

export default function ModelsPage() {
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("several");

  const load = useCallback(() => fetchModels()
    .then((list) => {
      setModels(list);
      setError("");
    })
    .catch((e) => setError(`Could not load models: ${e.message}`))
    .finally(() => setLoading(false)), []);

  useEffect(() => {
    fetchModels()
      .then(setModels)
      .catch((e) => setError(`Could not load models: ${e.message}`))
      .finally(() => setLoading(false));
  }, []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return models.filter((m) => {
      if (filter === "several" && m.offers.length < 2) return false;
      if (filter === "custom" && !m.policy) return false;
      if (!q) return true;
      return m.id.toLowerCase().includes(q) || m.offers.some((o) => routeLabel(o).toLowerCase().includes(q));
    });
  }, [models, query, filter]);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <p className="text-sm text-text-muted">
          API keys set to <strong>flat</strong> model ids (Endpoint &amp; Keys → key → &quot;Model ids in /v1/models&quot;)
          see one entry per model. A flat id tries its offers top to bottom, moving on when one fails. By default the
          cheapest comes first; reorder or switch offers off here. A switched-off offer is skipped by the flat id only:
          its full id still works.
        </p>
      </Card>

      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <Input
          placeholder="Search models or providers"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          icon="search"
          className="sm:max-w-sm w-full"
        />
        <SegmentedControl options={FILTERS} value={filter} onChange={setFilter} size="sm" />
        <span className="text-xs text-text-muted sm:ml-auto">{visible.length} of {models.length}</span>
      </div>

      {loading ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : error ? (
        <p className="text-sm text-feedback-danger-foreground">{error}</p>
      ) : visible.length === 0 ? (
        <Card>
          <p className="text-sm text-text-muted">
            {models.length === 0
              ? "No models yet: connect a provider first."
              : filter === "several"
                ? "No model is served by more than one connected provider. Show all to see every model."
                : "Nothing matches."}
          </p>
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          {visible.map((model) => <ModelRow key={model.key} model={model} onSaved={load} />)}
        </div>
      )}
    </div>
  );
}
