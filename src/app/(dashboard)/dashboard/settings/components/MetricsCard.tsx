"use client";

// Opt-in Prometheus scrape endpoint (GET /api/metrics). One switch, a scrape token minted
// server-side and shown once, the scrape URL and a ready-to-paste `scrape_configs` block.
// The switch and the token both take the current password when one is configured.

import { Gauge } from "lucide-react";
import Icon from "@/shared/components/Icon";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Card, Input, Toggle } from "@/shared/components";
import { useDisplayBaseUrl } from "@/shared/hooks";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

interface Notice {
  ok: boolean;
  message: string;
}

const METRICS_PATH = "/api/metrics";

function errorMessage(data: unknown, fallback: string): string {
  const message = (data as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof message === "string" && message ? message : fallback;
}

export default function MetricsCard() {
  const baseUrl = useDisplayBaseUrl();
  const { copied, copy } = useCopyToClipboard();

  const [loaded, setLoaded] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [hasPassword, setHasPassword] = useState(false);
  const [hasToken, setHasToken] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  // Held in memory only, and only until the operator dismisses it or leaves the page.
  const [freshToken, setFreshToken] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const settingsResponse = await fetch("/api/settings", { cache: "no-store" });
      if (settingsResponse.ok) {
        const data = await settingsResponse.json();
        setEnabled(data.prometheusMetricsEnabled === true);
        setHasPassword(Boolean(data.hasPassword));
      }
      const tokenResponse = await fetch("/api/metrics/token", { cache: "no-store" });
      if (tokenResponse.ok) {
        const data = await tokenResponse.json();
        setHasToken(data.hasToken === true);
      }
    } catch {
      // Leave the current state in place if the endpoints cannot be reached.
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const needsPassword = hasPassword && currentPassword.length === 0;

  const changeEnabled = async (next: boolean) => {
    if (needsPassword) {
      setNotice({ ok: false, message: "Enter your current password to change this setting." });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prometheusMetricsEnabled: next,
          ...(hasPassword ? { currentPassword } : {}),
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setNotice({ ok: false, message: errorMessage(data, "Could not save the setting.") });
        return;
      }
      setEnabled(next);
      setNotice({
        ok: true,
        message: next
          ? `On. ${METRICS_PATH} now answers authenticated scrapes.`
          : `Off. ${METRICS_PATH} now answers 404.`,
      });
    } finally {
      setBusy(false);
    }
  };

  const changeToken = async (method: "POST" | "DELETE") => {
    if (needsPassword) {
      setNotice({ ok: false, message: "Enter your current password to change the token." });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/metrics/token", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(hasPassword ? { currentPassword } : {}),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setNotice({ ok: false, message: errorMessage(data, "Could not change the token.") });
        return;
      }
      if (method === "POST" && typeof data?.token === "string") {
        setFreshToken(data.token);
        setHasToken(true);
        setNotice({
          ok: true,
          message: "Token generated. Copy it now: it is shown once and cannot be read again.",
        });
      } else {
        setFreshToken(null);
        setHasToken(false);
        setNotice({ ok: true, message: "Token revoked. Bearer scraping stops until you generate a new one." });
      }
    } finally {
      setBusy(false);
    }
  };

  const scrape = useMemo(() => {
    try {
      const url = new URL(baseUrl);
      return {
        url: `${baseUrl.replace(/\/$/, "")}${METRICS_PATH}`,
        host: url.host,
        scheme: url.protocol.replace(":", ""),
        path: `${url.pathname.replace(/\/$/, "")}${METRICS_PATH}`,
      };
    } catch {
      return { url: METRICS_PATH, host: "localhost:20128", scheme: "http", path: METRICS_PATH };
    }
  }, [baseUrl]);

  const snippet = [
    "scrape_configs:",
    "  - job_name: redrouter",
    `    metrics_path: ${scrape.path}`,
    ...(scrape.scheme === "https" ? ["    scheme: https"] : []),
    "    authorization:",
    "      type: Bearer",
    "      credentials: <your token>",
    "    static_configs:",
    `      - targets: ["${scrape.host}"]`,
  ].join("\n");

  return (
    <Card>
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-primary/10 text-primary">
            <Icon icon={Gauge} size="lg" color="current" />
          </div>
          <div>
            <h3 className="text-lg font-semibold">Prometheus metrics</h3>
            <p className="text-sm text-text-muted">
              Expose requests, tokens, cost, latency and breaker state at {METRICS_PATH} for
              Prometheus to scrape.
            </p>
          </div>
        </div>
        <Toggle
          checked={enabled}
          onChange={changeEnabled}
          disabled={!loaded || busy}
          ariaLabel="Enable the Prometheus metrics endpoint"
        />
      </div>

      {notice && (
        <p
          role="status"
          className={`mt-3 text-sm ${notice.ok ? "text-feedback-success-foreground" : "text-feedback-danger-foreground"}`}
        >
          {notice.message}
        </p>
      )}

      {hasPassword && (
        <div className="mt-4">
          <Input
            label="Current password"
            type="password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            hint="Needed to turn the endpoint on or off and to change its token."
            disabled={!loaded}
          />
        </div>
      )}

      {enabled && (
        <div className="mt-4 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <p className="text-sm font-medium text-text-main">Scrape URL</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 break-all rounded bg-surface px-3 py-2 font-mono text-xs text-text-main">
                {scrape.url}
              </code>
              <Button size="sm" variant="secondary" onClick={() => void copy(scrape.url, "url")}>
                {copied === "url" ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium text-text-main">Scrape token</p>
            <p className="text-xs text-text-muted">
              Prometheus cannot sign in with a cookie, so it sends this token as{" "}
              <code className="font-mono">Authorization: Bearer &lt;token&gt;</code>. A dashboard
              session works too.
            </p>
            {freshToken && (
              <div className="flex items-center gap-2 rounded border border-control-edge p-3">
                <code className="flex-1 break-all font-mono text-xs text-text-main">
                  {freshToken}
                </code>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void copy(freshToken, "token")}
                >
                  {copied === "token" ? "Copied" : "Copy"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setFreshToken(null)}>
                  Dismiss
                </Button>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => void changeToken("POST")} disabled={!loaded || busy}>
                {hasToken ? "Regenerate token" : "Generate token"}
              </Button>
              {hasToken && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void changeToken("DELETE")}
                  disabled={!loaded || busy}
                >
                  Revoke token
                </Button>
              )}
              <span className="text-xs text-text-muted">
                {hasToken ? "A token is set. Regenerating replaces it." : "No token yet."}
              </span>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <p className="text-sm font-medium text-text-main">Prometheus configuration</p>
            <pre className="overflow-auto rounded bg-surface px-3 py-2 font-mono text-xs text-text-main">
              {snippet}
            </pre>
          </div>
        </div>
      )}
    </Card>
  );
}
