"use client";

import { useState } from "react";
import { Button } from "@/shared/components";
import { extractApiErrorMessage } from "@/shared/http/apiErrorMessage";

type Days = 0 | 7 | 14 | 28;

type Props = {
  days: Days | null;
  onChange: (days: Days) => void;
  disabled?: boolean;
  onCleaned?: () => Promise<void>;
};

export default function SqliteHistoryRetentionControl({
  days,
  onChange,
  disabled,
  onCleaned,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  const cleanup = async () => {
    setBusy(true);
    setMessage("");
    setError(false);
    try {
      const response = await fetch("/api/settings/database/cleanup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(extractApiErrorMessage(body, "Cleanup failed."));
      setMessage(
        `Cleaned ${Number(body.deleted ?? 0).toLocaleString()} history rows. Larger backlogs continue on the next scheduled pass.`
      );
      await onCleaned?.();
    } catch (failure) {
      setError(true);
      setMessage(failure instanceof Error ? failure.message : "Unable to run cleanup.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mb-4">
      <label htmlFor="sqlite-history-window" className="block text-sm font-medium mb-1">
        Automatic SQLite history cleanup
      </label>
      <p id="sqlite-history-help" className="text-xs text-text-muted mb-2 max-w-prose">
        Keep operational logs, request payloads and completed task history for the selected window.
        Connections, credentials, tenants, users and financial records are preserved. Usage history
        keeps its separate retention rule below. Existing call-log row and file limits also apply
        when cleanup is enabled. Save to apply your choice.
      </p>
      <div className="flex items-center gap-3 flex-wrap">
        <select
          id="sqlite-history-window"
          aria-describedby="sqlite-history-help"
          value={days ?? "existing"}
          disabled={disabled || busy}
          onChange={(event) => {
            setMessage("");
            onChange(Number(event.target.value) as Days);
          }}
          className="px-3 py-2 text-sm rounded-lg border border-border bg-bg focus:outline-none focus:ring-2 focus:ring-primary"
        >
          {days === null && (
            <option value="existing" disabled>
              Existing per-category rules
            </option>
          )}
          <option value="0">Off</option>
          <option value="7">7 days</option>
          <option value="14">14 days</option>
          <option value="28">28 days</option>
        </select>
        <Button
          variant="outline"
          size="sm"
          loading={busy}
          disabled={disabled || !days}
          onClick={cleanup}
        >
          Run cleanup now
        </Button>
      </div>
      {message && (
        <p role={error ? "alert" : "status"} className="mt-2 text-xs text-text-muted">
          {message}
        </p>
      )}
    </div>
  );
}
