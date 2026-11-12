"use client";

import { useState, type ChangeEvent } from "react";
import { Button } from "../components";
import {
  extractRustProviderSessionZip,
  importRustProviderSession,
  importRustProviderSessionsBulk,
  type RustSessionImportOAuthKind,
  type RustProviderSessionBulkResult,
  type RustProviderSessionImportEntry,
} from "../api/browserClient";

const providerNames: Record<RustSessionImportOAuthKind, string> = {
  codex: "OpenAI Codex CLI",
  claude: "Claude Code",
  agy: "Antigravity",
};

function objectEntries(
  value: unknown,
  name?: string,
  email?: string
): RustProviderSessionImportEntry[] {
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0 || values.length > 50) {
    throw new Error("Import requires between 1 and 50 session records");
  }
  return values.map((json, index) => {
    if (!json || typeof json !== "object" || Array.isArray(json)) {
      throw new Error(`Session ${index + 1} must be a JSON object`);
    }
    return {
      json,
      ...(name ? { name: values.length === 1 ? name : `${name} ${index + 1}` } : {}),
      ...(email && values.length === 1 ? { email } : {}),
    };
  });
}

type Props = {
  onClose: () => void;
  onImported: () => Promise<void> | void;
};

export default function RustProviderSessionImportModal({ onClose, onImported }: Props) {
  const [provider, setProvider] = useState<RustSessionImportOAuthKind>("codex");
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [entries, setEntries] = useState<RustProviderSessionImportEntry[]>([]);
  const [overwriteExisting, setOverwriteExisting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RustProviderSessionBulkResult | null>(null);

  const selectFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const zipFiles = files.filter((file) => file.name.toLowerCase().endsWith(".zip"));
      if (zipFiles.length > 0) {
        if (files.length !== 1 || zipFiles.length !== 1) {
          throw new Error("Choose one ZIP archive or up to 50 JSON files");
        }
        if (zipFiles[0].size > 10 * 1024 * 1024) {
          throw new Error("ZIP archive exceeds the 10 MB limit");
        }
        const extracted = await extractRustProviderSessionZip(provider, zipFiles[0]);
        const valid = extracted
          .filter((entry) => !entry.parseError && entry.json)
          .map((entry) => ({ json: entry.json, name: entry.name.replace(/\.json$/i, "") }));
        if (valid.length === 0) throw new Error("ZIP archive contains no valid JSON sessions");
        setEntries(valid);
        return;
      }
      if (files.length > 50) throw new Error("Choose at most 50 JSON files");
      const parsed = await Promise.all(
        files.map(async (file) => {
          if (file.size > 256 * 1024) throw new Error(`${file.name} exceeds the 256 KB limit`);
          return objectEntries(JSON.parse(await file.text()), file.name.replace(/\.json$/i, ""));
        })
      );
      const flattened = parsed.flat();
      if (flattened.length > 50) throw new Error("Import contains more than 50 sessions");
      setEntries(flattened);
    } catch (cause) {
      setEntries([]);
      setError(cause instanceof Error ? cause.message : "Could not read provider sessions");
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const selected =
        entries.length > 0
          ? entries
          : objectEntries(JSON.parse(text), name.trim() || undefined, email.trim() || undefined);
      if (selected.length === 1) {
        await importRustProviderSession(provider, selected[0], overwriteExisting);
        await onImported();
        onClose();
        return;
      }
      const imported = await importRustProviderSessionsBulk(provider, selected, overwriteExisting);
      setResult(imported);
      if (imported.success > 0) await onImported();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Provider session import failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-black/10 bg-surface p-5 shadow-2xl dark:border-white/10"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rust-session-import-title"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="rust-session-import-title" className="text-lg font-semibold text-text">
              Import CLI provider sessions
            </h2>
            <p className="mt-1 text-sm text-text-muted">
              The server validates the session, identifies the account and stores
              credentials encrypted. Imported secrets are never returned by the API.
            </p>
          </div>
          <button
            type="button"
            className="rounded px-2 py-1 text-text-muted hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/5"
            disabled={busy}
            aria-label="Close session import"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        {error && (
          <div
            className="mt-4 rounded-lg border border-feedback-danger-border bg-feedback-danger-surface p-3 text-sm text-feedback-danger-foreground"
            role="alert"
          >
            {error}
          </div>
        )}
        {result && (
          <div
            className="mt-4 rounded-lg border border-feedback-success-border bg-feedback-success-surface p-3 text-sm text-feedback-success-foreground"
            role="status"
          >
            Imported {result.success} of {result.total} sessions.
            {result.failed > 0 && ` ${result.failed} failed validation.`}
          </div>
        )}

        <div className="mt-5 grid gap-3 md:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs font-medium text-text-muted">
            Provider session type
            <select
              className="rounded-lg border border-black/10 bg-surface px-3 py-2 text-sm text-text dark:border-white/10"
              value={provider}
              disabled={busy}
              onChange={(event) => {
                setProvider(event.target.value as RustSessionImportOAuthKind);
                setEntries([]);
                setResult(null);
              }}
            >
              {Object.entries(providerNames).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-text-muted">
            JSON files or one ZIP archive
            <input
              className="rounded-lg border border-black/10 bg-surface px-3 py-2 text-sm text-text dark:border-white/10"
              type="file"
              accept=".json,.zip,application/json,application/zip"
              multiple
              disabled={busy}
              onChange={(event) => void selectFiles(event)}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-text-muted">
            Connection label (single pasted session)
            <input
              className="rounded-lg border border-black/10 bg-surface px-3 py-2 text-sm text-text dark:border-white/10"
              value={name}
              maxLength={128}
              disabled={busy || entries.length > 0}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-text-muted">
            Account email override (single pasted session)
            <input
              className="rounded-lg border border-black/10 bg-surface px-3 py-2 text-sm text-text dark:border-white/10"
              type="email"
              value={email}
              maxLength={320}
              disabled={busy || entries.length > 0}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
        </div>
        <label className="mt-3 flex flex-col gap-1 text-xs font-medium text-text-muted">
          Or paste one JSON object or an array of up to 50 sessions
          <textarea
            className="min-h-44 rounded-lg border border-black/10 bg-surface px-3 py-2 font-mono text-xs text-text focus:outline-none focus:ring-2 focus:ring-primary/40 dark:border-white/10"
            value={text}
            disabled={busy || entries.length > 0}
            autoComplete="off"
            spellCheck={false}
            maxLength={10 * 1024 * 1024}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        {entries.length > 0 && (
          <div className="mt-3 flex items-center justify-between rounded-lg border border-black/10 p-3 text-xs text-text-muted dark:border-white/10">
            <span>{entries.length} valid session files ready to import</span>
            <button
              type="button"
              className="text-primary hover:underline"
              disabled={busy}
              onClick={() => setEntries([])}
            >
              Clear files
            </button>
          </div>
        )}
        <label className="mt-3 flex items-center gap-2 text-sm text-text">
          <input
            type="checkbox"
            checked={overwriteExisting}
            disabled={busy}
            onChange={(event) => setOverwriteExisting(event.target.checked)}
          />
          Replace an existing connection for the same verified account
        </label>
        <div className="mt-5 flex flex-wrap gap-2">
          <Button
            loading={busy}
            disabled={entries.length === 0 && !text.trim()}
            onClick={() => void submit()}
          >
            Import sessions
          </Button>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            {result ? "Done" : "Cancel"}
          </Button>
        </div>
      </section>
    </div>
  );
}
