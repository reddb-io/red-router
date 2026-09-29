"use client";

import { useId, useMemo, useState } from "react";
import { Checkbox, Input } from "@/shared/components";
import { matchesSearch } from "@/shared/utils/turkishText";
import type { AssignableRef } from "./budgetsTypes";

/** Options above which a search box is worth its space. */
const SEARCH_THRESHOLD = 8;

interface AssignmentPickerProps {
  label: string;
  options: AssignableRef[];
  selected: string[];
  onChange: (selected: string[]) => void;
  searchPlaceholder: string;
  emptyText: string;
  loading?: boolean;
}

/** A searchable checklist: many-of-many selection of API keys or key groups by id. */
export function AssignmentPicker({
  label,
  options,
  selected,
  onChange,
  searchPlaceholder,
  emptyText,
  loading = false,
}: AssignmentPickerProps) {
  const [query, setQuery] = useState("");
  const groupId = useId();
  const chosen = useMemo(() => new Set(selected), [selected]);
  const visible = options.filter((option) => matchesSearch(option.name, query));

  const toggle = (id: string, on: boolean) =>
    onChange(on ? [...selected, id] : selected.filter((entry) => entry !== id));

  return (
    <fieldset className="flex min-w-0 flex-col gap-2">
      <legend className="mb-1 flex w-full items-center justify-between text-sm font-medium text-text-main">
        <span>{label}</span>
        <span className="text-xs font-normal text-text-muted">{selected.length}</span>
      </legend>
      {options.length > SEARCH_THRESHOLD ? (
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
          icon="search"
        />
      ) : null}
      <div className="max-h-40 overflow-y-auto rounded-md border border-border">
        {visible.map((option) => (
          <div
            key={option.id}
            className="border-b border-border px-3 py-1.5 last:border-b-0 hover:bg-bg-subtle"
          >
            <Checkbox
              id={`${groupId}-${option.id}`}
              label={<span className="truncate">{option.name}</span>}
              checked={chosen.has(option.id)}
              onChange={(event) => toggle(option.id, event.target.checked)}
            />
          </div>
        ))}
        {!loading && visible.length === 0 ? (
          <p className="px-3 py-2 text-xs text-text-muted">{emptyText}</p>
        ) : null}
      </div>
    </fieldset>
  );
}
