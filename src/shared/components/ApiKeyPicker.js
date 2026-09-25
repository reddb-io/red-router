"use client";

import { useEffect, useState } from "react";
import Input from "./Input";
import Icon from "./Icon";

const PICKER_PAGE = 20;

// Pick API keys by searching the server a page at a time (/api/keys/search), so
// it works the same with 5 keys or 50,000. `selected` is [{ id, name }], shown
// as removable chips.
export default function ApiKeyPicker({ selected, onChange }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState({ keys: [], total: 0 });
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/keys/search?q=${encodeURIComponent(query)}&limit=${PICKER_PAGE}`);
        const data = await res.json().catch(() => ({}));
        if (!cancelled) setResults({ keys: data.keys || [], total: data.total || 0 });
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query]);

  const chosen = new Set(selected.map((k) => k.id));
  const add = (k) => onChange([...selected, { id: k.id, name: k.name }]);
  const remove = (id) => onChange(selected.filter((k) => k.id !== id));

  return (
    <div className="flex flex-col gap-2">
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((k) => (
            <span key={k.id} className="inline-flex items-center gap-1 rounded-full bg-primary/10 py-0.5 pl-2.5 pr-1 text-xs text-primary">
              {k.name || "deleted key"}
              <button type="button" onClick={() => remove(k.id)} className="grid size-5 place-items-center rounded-full hover:bg-primary/20" aria-label={`Remove ${k.name || "key"}`}>
                <Icon name="close" size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search keys by name or tag" icon="search" />
      <div className="max-h-48 overflow-y-auto rounded-md border border-border">
        {results.keys.filter((k) => !chosen.has(k.id)).map((k) => (
          <button
            key={k.id}
            type="button"
            onClick={() => add(k)}
            className="flex w-full items-center justify-between gap-3 border-b border-border/50 px-3 py-2 text-left text-sm last:border-b-0 hover:bg-surface-2"
          >
            <span className="min-w-0 truncate">{k.name || "Unnamed key"}</span>
            {k.tags.length > 0 && <span className="shrink-0 truncate text-xs text-ink-muted">{k.tags.join(", ")}</span>}
          </button>
        ))}
        {!searching && results.keys.length === 0 && <p className="px-3 py-2 text-xs text-ink-muted">{query ? "No key matches." : "No API keys yet."}</p>}
      </div>
      {results.total > results.keys.length && (
        <p className="text-xs text-ink-muted">Showing {results.keys.length} of {results.total.toLocaleString()} keys: refine the search to find others.</p>
      )}
    </div>
  );
}
