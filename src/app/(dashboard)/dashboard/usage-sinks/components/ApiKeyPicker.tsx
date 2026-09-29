"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Input } from "@/shared/components";
import type { KeyRef } from "../types";

const PAGE = 20;

interface ApiKeyPickerProps {
  selected: KeyRef[];
  onChange: (selected: KeyRef[]) => void;
}

/**
 * Pick API keys by searching the server a page at a time (/api/keys/search), so it works the same
 * with 5 keys or 50,000: the page never loads them all. `selected` is shown as removable chips.
 */
export function ApiKeyPicker({ selected, onChange }: ApiKeyPickerProps) {
  const t = useTranslations("usageSinks");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<KeyRef[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [more, setMore] = useState(0);

  // A new search starts over; "Show more" widens the same search.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/keys/search?q=${encodeURIComponent(query)}&limit=${PAGE}&offset=${more * PAGE}`
        );
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        const keys: KeyRef[] = Array.isArray(data.keys) ? data.keys : [];
        setResults((current) => (more === 0 ? keys : [...current, ...keys]));
        setTotal(typeof data.total === "number" ? data.total : 0);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, more]);

  const chosen = new Set(selected.map((key) => key.id));
  const add = (key: KeyRef) => onChange([...selected, { id: key.id, name: key.name }]);
  const remove = (id: string) => onChange(selected.filter((key) => key.id !== id));
  const visible = results.filter((key) => !chosen.has(key.id));

  return (
    <div className="flex flex-col gap-2">
      {selected.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label={t("selectedKeys")}>
          {selected.map((key) => (
            <li
              key={key.id}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-bg-subtle py-0.5 pl-2.5 pr-1 text-xs text-text-main"
            >
              {key.name || t("deletedKey")}
              <button
                type="button"
                onClick={() => remove(key.id)}
                className="grid size-5 place-items-center rounded-full text-text-muted hover:text-text-main"
                aria-label={t("removeKey", { name: key.name || t("deletedKey") })}
              >
                <span className="material-symbols-outlined text-[14px] leading-none">close</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <Input
        value={query}
        onChange={(event) => {
          setMore(0);
          setQuery(event.target.value);
        }}
        placeholder={t("searchKeys")}
        icon="search"
        aria-label={t("searchKeys")}
      />
      <div className="max-h-48 overflow-y-auto rounded-md border border-border">
        {visible.map((key) => (
          <button
            key={key.id}
            type="button"
            onClick={() => add(key)}
            className="flex w-full items-center justify-between gap-3 border-b border-border px-3 py-2 text-left text-sm text-text-main last:border-b-0 hover:bg-bg-subtle"
          >
            <span className="min-w-0 truncate">{key.name || t("unnamedKey")}</span>
            <span className="material-symbols-outlined text-[16px] text-text-muted">add</span>
          </button>
        ))}
        {!loading && visible.length === 0 ? (
          <p className="px-3 py-2 text-xs text-text-muted">
            {query ? t("noKeyMatches") : t("noKeys")}
          </p>
        ) : null}
      </div>
      {results.length < total ? (
        <div className="flex items-center justify-between gap-2 text-xs text-text-muted">
          <span>{t("showingKeys", { shown: results.length, total })}</span>
          <Button size="sm" variant="ghost" loading={loading} onClick={() => setMore(more + 1)}>
            {t("showMore")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
