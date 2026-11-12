"use client";

import { useEffect, useState } from "react";
import { Button } from "@/shared/components";
import {
  authorizeRustProviderOAuth,
  exchangeRustProviderOAuth,
  type RustProviderOAuthAuthorization,
  type RustBrowserOAuthKind,
} from "@/lib/rustControlPlane/browserClient";

const providerNames: Record<RustBrowserOAuthKind, string> = {
  codex: "OpenAI Codex CLI",
  claude: "Claude Code",
  agy: "Antigravity",
  "xai-oauth": "xAI API OAuth",
};

function requestedRedirectUri(provider: RustBrowserOAuthKind): string {
  if (provider === "codex") return "http://localhost:1455/auth/callback";
  if (provider === "agy") {
    return `http://127.0.0.1:${window.location.port || "20128"}/callback`;
  }
  if (provider === "xai-oauth") return "http://127.0.0.1:56121/callback";
  return `${window.location.origin}/callback`;
}

function callbackValues(
  input: string,
  authorization: RustProviderOAuthAuthorization
): { code: string; state: string } {
  const value = input.trim();
  if (!value) throw new Error("Paste the authorization code or final callback URL");
  if (value.startsWith("http://") || value.startsWith("https://")) {
    let callback: URL;
    try {
      callback = new URL(value);
    } catch {
      throw new Error("The callback URL is invalid");
    }
    const oauthError =
      callback.searchParams.get("error_description") ?? callback.searchParams.get("error");
    if (oauthError) throw new Error(`Provider authorization failed: ${oauthError}`);
    const code = callback.searchParams.get("code")?.trim();
    if (!code) throw new Error("The callback URL does not contain an authorization code");
    return {
      code,
      state: callback.searchParams.get("state")?.trim() || authorization.state,
    };
  }
  return { code: value, state: authorization.state };
}

type Props = {
  provider: RustBrowserOAuthKind;
  connectionId?: string;
  onClose: () => void;
  onSuccess: () => Promise<void> | void;
};

export default function RustProviderOAuthModal({
  provider,
  connectionId,
  onClose,
  onSuccess,
}: Props) {
  const [authorization, setAuthorization] = useState<RustProviderOAuthAuthorization | null>(null);
  const [callback, setCallback] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void authorizeRustProviderOAuth(provider, requestedRedirectUri(provider))
      .then((value) => {
        if (active) setAuthorization(value);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "Could not start sign-in");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [provider]);

  const finish = async () => {
    if (!authorization) return;
    setSubmitting(true);
    setError(null);
    try {
      const values = callbackValues(callback, authorization);
      await exchangeRustProviderOAuth(provider, {
        ...values,
        redirectUri: authorization.redirectUri,
        codeVerifier: authorization.codeVerifier,
        ...(connectionId ? { connectionId } : {}),
      });
      await onSuccess();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Provider sign-in failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) onClose();
      }}
    >
      <section
        className="w-full max-w-xl rounded-xl border border-black/10 bg-surface p-5 shadow-2xl dark:border-white/10"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rust-provider-oauth-title"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="rust-provider-oauth-title" className="text-lg font-semibold text-text">
              {connectionId ? "Reconnect" : "Connect"} {providerNames[provider]}
            </h2>
            <p className="mt-1 text-sm text-text-muted">
              The Rust backend owns the OAuth state and stores the resulting credentials encrypted.
            </p>
          </div>
          <button
            type="button"
            className="rounded px-2 py-1 text-text-muted hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/5"
            disabled={submitting}
            aria-label="Close provider sign-in"
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

        {loading ? (
          <p className="mt-5 text-sm text-text-muted" role="status">
            Preparing a secure sign-in…
          </p>
        ) : authorization ? (
          <div className="mt-5 flex flex-col gap-4">
            <div>
              <Button
                onClick={() => window.open(authorization.authUrl, "_blank", "noopener,noreferrer")}
              >
                Open provider sign-in
              </Button>
              <p className="mt-2 text-xs text-text-muted">
                Complete sign-in in the new tab. If the browser cannot reach the loopback callback,
                copy its final URL from the address bar.
              </p>
            </div>
            <label className="flex flex-col gap-1 text-xs font-medium text-text-muted">
              Authorization code or final callback URL
              <textarea
                className="min-h-24 w-full rounded-lg border border-black/10 bg-surface px-3 py-2 font-mono text-xs text-text focus:outline-none focus:ring-2 focus:ring-primary/40 dark:border-white/10"
                value={callback}
                autoComplete="off"
                spellCheck={false}
                maxLength={12_000}
                placeholder={
                  provider === "claude"
                    ? "Paste the code shown by Claude (code#state is accepted)"
                    : `${authorization.redirectUri}?code=...&state=...`
                }
                onChange={(event) => setCallback(event.target.value)}
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button
                loading={submitting}
                disabled={!callback.trim()}
                onClick={() => void finish()}
              >
                Complete connection
              </Button>
              <Button variant="secondary" disabled={submitting} onClick={onClose}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-5">
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}
