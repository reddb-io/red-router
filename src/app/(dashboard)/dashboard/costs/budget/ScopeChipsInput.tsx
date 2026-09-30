"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Badge, Button, Input } from "@/shared/components";
import Icon from "@/shared/components/Icon";
import { X } from "lucide-react";

interface ScopeChipsInputProps {
  label: string;
  hint: string;
  placeholder: string;
  values: string[];
  onChange: (values: string[]) => void;
  /** The stored form of what was typed, or null when it is not acceptable. */
  normalize: (raw: string) => string | null;
  /** Splits one entry into several (tags accept a comma-separated list). */
  splitOn?: string;
}

/**
 * Free-text assignment: type a tag or an end-user id, press Enter or Add, and it becomes a chip.
 * Values are client-supplied text, so they are only ever rendered as React text (escaped) and
 * bounded by `normalize`.
 */
export function ScopeChipsInput({
  label,
  hint,
  placeholder,
  values,
  onChange,
  normalize,
  splitOn,
}: ScopeChipsInputProps) {
  const t = useTranslations("budgets");
  const [text, setText] = useState("");
  const [error, setError] = useState("");

  const add = () => {
    const parts = splitOn ? text.split(splitOn) : [text];
    const next = [...values];
    for (const part of parts) {
      if (part.trim() === "") continue;
      const value = normalize(part);
      if (value === null) {
        setError(t("errChipInvalid"));
        return;
      }
      if (!next.includes(value)) next.push(value);
    }
    setError("");
    setText("");
    onChange(next);
  };

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-end gap-2">
        <Input
          label={label}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
          placeholder={placeholder}
          hint={error ? undefined : hint}
          error={error || undefined}
          className="min-w-0 flex-1"
        />
        <Button variant="secondary" icon="add" onClick={add} disabled={text.trim() === ""}>
          {t("addChip")}
        </Button>
      </div>
      {values.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label={label}>
          {values.map((value) => (
            <li key={value}>
              <Badge size="sm" variant="outline">
                <span className="max-w-48 truncate" title={value}>
                  {value}
                </span>
                <button
                  type="button"
                  className="inline-flex cursor-pointer items-center rounded-sm text-ink-muted hover:text-foreground"
                  aria-label={t("removeChip", { value })}
                  onClick={() => onChange(values.filter((entry) => entry !== value))}
                >
                  <Icon icon={X} size="sm" color="current" />
                </button>
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
