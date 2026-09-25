"use client";

import { useEffect, useState } from "react";
import { Card, Button, Icon } from "@/shared/components";

// Settings → Branding: paste a white-label branding.json (src/lib/branding.js),
// validate it, apply it. Only the visual identity, login screen and theme change.
const EXAMPLE = {
  name: "Acme AI Gateway",
  logo: "https://example.com/acme-logo.svg",
  logoDark: "https://example.com/acme-logo-white.svg",
  favicon: "https://example.com/favicon.svg",
  login: {
    title: "Acme AI Gateway",
    subtitle: "Sign in with your Acme account",
    background: "#0b1020",
    footer: "© Acme Inc.",
  },
  theme: {
    primary: "#2563eb",
    primaryHover: "#1d4ed8",
    radius: "0.5rem",
    fontFamily: "Inter, system-ui, sans-serif",
    colorScheme: "system",
    light: { "--reddb-color-background": "#ffffff" },
    dark: { "--reddb-color-background": "#0b1020" },
  },
};

export default function BrandingCard() {
  const [text, setText] = useState("");
  const [file, setFile] = useState("");
  const [active, setActive] = useState(false);
  const [errors, setErrors] = useState([]);
  const [status, setStatus] = useState({ type: "", text: "" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/settings/branding", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        setFile(data.file || "");
        setActive(!!data.branding);
        setText(data.branding ? JSON.stringify(data.branding, null, 2) : "");
        setErrors(data.errors || []);
      })
      .catch(() => {});
  }, []);

  async function send(dryRun) {
    setStatus({ type: "", text: "" });
    let body;
    try {
      body = JSON.parse(text);
    } catch (e) {
      setErrors([`Not valid JSON: ${e.message}`]);
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/settings/branding${dryRun ? "?dryRun=1" : ""}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      setErrors(data.errors || []);
      if (!res.ok) return;
      if (dryRun) {
        setStatus({ type: data.errors?.length ? "warn" : "ok", text: data.errors?.length ? "Valid, with the problems below (those fields are ignored)." : "Valid." });
      } else {
        setStatus({ type: "ok", text: "Saved. Reloading to apply…" });
        setTimeout(() => window.location.reload(), 600);
      }
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await fetch("/api/settings/branding", { method: "DELETE" });
      setStatus({ type: "ok", text: "Branding removed. Reloading…" });
      setTimeout(() => window.location.reload(), 600);
    } finally {
      setBusy(false);
    }
  }

  const statusClass = { ok: "text-feedback-success-foreground", warn: "text-feedback-warning-foreground" }[status.type] || "text-text-muted";

  return (
    <Card>
      <div className="mb-4 flex items-center gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-feedback-info-surface text-feedback-info-foreground">
          <Icon name="palette" size={20} />
        </div>
        <div className="min-w-0">
          <h3 className="text-base font-semibold sm:text-lg">Branding</h3>
          <p className="text-xs text-text-muted sm:text-sm">
            White label: name, logo, favicon, login screen and theme, from one JSON. {active ? "Custom branding is active." : "Using the default RedRouter look."}
          </p>
        </div>
      </div>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={14}
        spellCheck={false}
        placeholder={JSON.stringify(EXAMPLE, null, 2)}
        className="w-full rounded-md border border-border bg-bg px-3 py-2 font-mono text-xs text-text-main focus:outline-none focus:ring-2 focus:ring-primary/30"
        aria-label="branding.json"
      />

      {errors.length > 0 && (
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-feedback-warning-foreground">
          {errors.map((e) => <li key={e}>{e}</li>)}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" onClick={() => send(false)} loading={busy} disabled={!text.trim()}>Save and apply</Button>
        <Button size="sm" variant="secondary" onClick={() => send(true)} disabled={busy || !text.trim()}>Validate</Button>
        {!text.trim() && <Button size="sm" variant="ghost" onClick={() => setText(JSON.stringify(EXAMPLE, null, 2))}>Start from an example</Button>}
        {active && <Button size="sm" variant="ghost" icon="delete" onClick={remove} disabled={busy}>Back to default</Button>}
        {status.text && <span className={`text-xs ${statusClass}`}>{status.text}</span>}
      </div>

      <p className="mt-3 text-xs text-text-muted">
        Images: an https URL, a <code>data:image/…;base64,</code> URI, or a file name placed next to{" "}
        <code className="break-all">{file || "branding.json"}</code>. Theme tokens accept <code>--reddb-*</code> and <code>--color-*</code> custom properties, per light and dark scheme.
        The file can also be managed directly (or pointed to with <code>RED_ROUTER_BRANDING</code>).
      </p>
    </Card>
  );
}
