"use client";

import { useState } from "react";
import { Button, Input, Select, Toggle } from "@/shared/components";
import OrderEditor from "./ProviderOrderEditor";
import type { ProviderOption } from "./providerPriorityList";

export interface Profile {
  id: string;
  name: string;
  transparent: boolean | null;
  providerPriority: string[] | null;
  attachments: number;
}
type Draft = {
  id?: string;
  name: string;
  mode: "inherit" | "on" | "off";
  custom: boolean;
  order: string[];
};

export default function RoutingProfilesEditor({
  profiles,
  providers,
  onChanged,
  disabled,
  onBusyChange,
  onEditingChange,
}: {
  profiles: Profile[];
  providers: ProviderOption[];
  onChanged: () => Promise<void>;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onEditingChange?: (editing: boolean) => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const patch = (value: Partial<Draft>) =>
    setDraft((current) => (current ? { ...current, ...value } : null));
  const edit = (value: Draft | null) => {
    setDraft(value);
    onEditingChange?.(value !== null);
  };
  const write = async (method: "POST" | "PUT" | "DELETE", id?: string) => {
    setBusy(true);
    onBusyChange?.(true);
    setError(null);
    try {
      const res = await fetch(`/api/routing/profiles${id ? `/${encodeURIComponent(id)}` : ""}`, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(method !== "DELETE" && draft
          ? {
              body: JSON.stringify({
                name: draft.name,
                transparent: draft.mode === "inherit" ? null : draft.mode === "on",
                providerPriority: draft.custom ? draft.order : null,
              }),
            }
          : {}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || "Could not update the profile.");
      edit(null);
      await onChanged();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not update the profile.");
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  };
  return (
    <fieldset
      disabled={disabled || busy}
      className="space-y-3 border-b border-border pb-4"
      aria-label="Reusable routing profiles"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Reusable routing profiles</h3>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !!draft}
          onClick={() => {
            setError(null);
            edit({ name: "", mode: "off", custom: false, order: [] });
          }}
        >
          New profile
        </Button>
      </div>
      <p className="max-w-prose text-xs text-text-muted">
        Create shared model visibility and provider order. Profiles apply only when attached below.
        They never enable connections or expand key or tenant access.
      </p>
      {disabled && (
        <p className="text-xs text-text-muted">
          Save your pending routing changes before editing shared profiles.
        </p>
      )}
      {profiles.length === 0 ? (
        <p className="text-sm text-text-muted">
          No profiles yet. Stored routing settings continue to apply.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {profiles.map((profile) => (
            <li key={profile.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <span className="font-medium">{profile.name}</span>
                <p className="text-xs text-text-muted">
                  {profile.attachments} {profile.attachments === 1 ? "attachment" : "attachments"} ·{" "}
                  {profile.transparent === null
                    ? "Visibility inherited"
                    : profile.transparent
                      ? "Prefixes visible"
                      : "Prefixes hidden"}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !!draft}
                onClick={() => {
                  setError(null);
                  edit({
                    id: profile.id,
                    name: profile.name,
                    mode:
                      profile.transparent === null ? "inherit" : profile.transparent ? "on" : "off",
                    custom: profile.providerPriority !== null,
                    order: profile.providerPriority ?? [],
                  });
                }}
              >
                Edit {profile.name}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || !!draft || profile.attachments > 0}
                title={
                  profile.attachments
                    ? "Detach this profile before deleting it."
                    : "Delete unattached profile"
                }
                onClick={() => void write("DELETE", profile.id)}
              >
                Delete {profile.name}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {draft && (
        <fieldset disabled={busy} className="space-y-3">
          <Input
            label="Profile name"
            value={draft.name}
            maxLength={100}
            onChange={(event) => patch({ name: event.target.value })}
          />
          <Select
            label="Profile model visibility"
            value={draft.mode}
            onChange={(event) => patch({ mode: event.target.value as Draft["mode"] })}
            options={[
              { value: "inherit", label: "Leave visibility inherited" },
              { value: "on", label: "Provider prefixes visible" },
              { value: "off", label: "Provider prefixes hidden" },
            ]}
          />
          <Toggle
            label="Define provider priority in this profile"
            checked={draft.custom}
            onChange={(custom) => patch({ custom })}
          />
          {draft.custom && (
            <OrderEditor
              order={draft.order}
              providers={providers}
              label="Profile provider priority"
              onChange={(order) => patch({ order })}
            />
          )}
          {draft.id && (
            <p className="text-xs text-text-muted">
              Saving updates every attachment. Local overrides keep their values.
            </p>
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={!draft.name.trim() || (draft.mode === "inherit" && !draft.custom)}
              onClick={() => void write(draft.id ? "PUT" : "POST", draft.id)}
            >
              {busy ? "Saving..." : "Save profile"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => edit(null)}>
              Cancel
            </Button>
          </div>
        </fieldset>
      )}
      {error && (
        <p role="alert" className="text-sm text-feedback-danger-foreground">
          {error}
        </p>
      )}
    </fieldset>
  );
}
