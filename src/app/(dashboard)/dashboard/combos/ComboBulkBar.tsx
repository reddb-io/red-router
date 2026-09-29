"use client";

// Bulk actions and client presets for the combos list: select combos to delete them or change
// their strategy in one go, and add the default Claude Code / Cursor combos. The server does the
// work (`/api/combos/bulk`, `/api/combos/presets`); this bar only collects the choice.

import { useState } from "react";
import { Button, ConfirmModal, Select } from "@/shared/components";
import { ROUTING_STRATEGY_VALUES } from "@/shared/constants/routingStrategies";
import { useNotificationStore } from "@/store/notificationStore";

interface ComboBulkBarProps {
  /** Ids of the combos the list currently shows. */
  visibleIds: readonly string[];
  selectedIds: ReadonlySet<string>;
  onSelectedChange: (ids: Set<string>) => void;
  /** Reload the list after the server changed something. */
  onChanged: () => Promise<void> | void;
}

const STRATEGY_OPTIONS = ROUTING_STRATEGY_VALUES.map((value) => ({ value, label: value }));

async function post(path: string, body: unknown) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : "Request failed");
  return data;
}

export default function ComboBulkBar({
  visibleIds,
  selectedIds,
  onSelectedChange,
  onChanged,
}: ComboBulkBarProps) {
  const notify = useNotificationStore();
  const [strategy, setStrategy] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const count = selectedIds.size;
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));

  const run = async (work: () => Promise<string>) => {
    setBusy(true);
    try {
      notify.success(await work());
      await onChanged();
    } catch (error) {
      notify.error(error instanceof Error ? error.message : "Request failed");
    } finally {
      setBusy(false);
    }
  };

  const applyStrategy = () =>
    run(async () => {
      const result = await post("/api/combos/bulk", {
        action: "setStrategy",
        ids: [...selectedIds],
        strategy,
      });
      setStrategy("");
      return `Strategy changed on ${result.succeeded} combo${result.succeeded === 1 ? "" : "s"}`;
    });

  const deleteSelected = () =>
    run(async () => {
      const result = await post("/api/combos/bulk", { action: "delete", ids: [...selectedIds] });
      setConfirmDelete(false);
      onSelectedChange(new Set());
      return `Deleted ${result.succeeded} combo${result.succeeded === 1 ? "" : "s"}`;
    });

  const addPresets = (source: "claude" | "cursor") =>
    run(async () => {
      const result = await post("/api/combos/presets", { source });
      return result.createdCount > 0
        ? `Added ${result.createdCount} ${source === "claude" ? "Claude Code" : "Cursor"} combos`
        : "Nothing to add: every preset already exists";
    });

  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-lg border border-elevation-sunken-border px-3 py-2"
      data-testid="combo-bulk-bar"
    >
      <label className="flex items-center gap-2 text-sm text-text-main">
        <input
          type="checkbox"
          checked={allSelected}
          disabled={visibleIds.length === 0}
          onChange={(event) =>
            onSelectedChange(event.target.checked ? new Set(visibleIds) : new Set())
          }
        />
        {count > 0 ? `${count} selected` : "Select all"}
      </label>

      {count > 0 && (
        <>
          <Select
            aria-label="Strategy for the selected combos"
            value={strategy}
            onChange={(event) => setStrategy(event.target.value)}
            options={STRATEGY_OPTIONS}
            placeholder="Set strategy…"
            className="w-44"
          />
          <Button size="sm" variant="secondary" disabled={!strategy || busy} onClick={applyStrategy}>
            Apply
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon="delete"
            disabled={busy}
            onClick={() => setConfirmDelete(true)}
          >
            Delete
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onSelectedChange(new Set())}>
            Clear
          </Button>
        </>
      )}

      <div className="ms-auto flex items-center gap-2">
        <span className="text-xs text-text-muted">Add default combos for</span>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => addPresets("claude")}>
          Claude Code
        </Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => addPresets("cursor")}>
          Cursor
        </Button>
      </div>

      <ConfirmModal
        isOpen={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={deleteSelected}
        title="Delete combos"
        message={`Delete ${count} selected combo${count === 1 ? "" : "s"}? This cannot be undone.`}
        confirmText="Delete"
        loading={busy}
      />
    </div>
  );
}
