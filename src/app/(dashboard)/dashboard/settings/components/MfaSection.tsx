"use client";

// Second factor for the password sign-in: an authenticator app (TOTP) plus one-time recovery codes.
// Turning it on is a two-step proof (the secret is shown once, then a code from the app confirms it).
// Single sign-on (OIDC / SAML) leaves the second factor to the identity provider.

import { KeyRound } from "lucide-react";
import Icon from "@/shared/components/Icon";
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, Input } from "@/shared/components";

interface MfaState {
  enabled: boolean;
  pendingSetup: boolean;
  recoveryCodesRemaining: number;
}

interface Setup {
  secret: string;
  otpauthUri: string;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

function errorMessage(data: unknown, fallback: string): string {
  const error = (data as { error?: unknown } | null)?.error;
  return typeof error === "string" && error ? error : fallback;
}

export default function MfaSection() {
  const [state, setState] = useState<MfaState | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [mode, setMode] = useState<"idle" | "disable" | "regenerate">("idle");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/mfa");
      if (res.ok) setState((await res.json()) as MfaState);
    } catch {
      setState(null);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const call = async (path: string, body: unknown) => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ ok: false, text: errorMessage(data, `The request failed (${res.status}).`) });
        return null;
      }
      return data as Record<string, unknown>;
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    const data = await call("/api/settings/mfa/setup", {});
    if (data) setSetup(data as unknown as Setup);
  };

  const enable = async () => {
    const data = await call("/api/settings/mfa/enable", { code });
    if (!data) return;
    setRecoveryCodes(data.recoveryCodes as string[]);
    setSetup(null);
    setCode("");
    await load();
  };

  const disable = async () => {
    const data = await call("/api/settings/mfa/disable", { code, password });
    if (!data) return;
    setMode("idle");
    setCode("");
    setPassword("");
    setRecoveryCodes(null);
    setMessage({ ok: true, text: "Second factor is off." });
    await load();
  };

  const regenerate = async () => {
    const data = await call("/api/settings/mfa/recovery-codes", { code });
    if (!data) return;
    setRecoveryCodes(data.recoveryCodes as string[]);
    setMode("idle");
    setCode("");
    await load();
  };

  const enabled = state?.enabled === true;

  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 rounded-lg bg-primary/10 text-primary">
          <Icon icon={KeyRound} size="lg" color="current" />
        </div>
        <div className="flex-1">
          <p className="font-medium">Two-factor authentication</p>
          <p className="text-sm text-text-muted">
            Ask for a code from an authenticator app after the password. Sign-in through OIDC or
            SAML leaves this to your identity provider.
          </p>
        </div>
        {state ? (
          <Badge size="sm" variant={enabled ? "success" : "outline"}>
            {enabled ? "On" : "Off"}
          </Badge>
        ) : null}
      </div>

      <div className="flex flex-col gap-3">
        {message ? (
          <p
            role="status"
            className={`text-sm ${message.ok ? "text-feedback-success-foreground" : "text-feedback-danger-foreground"}`}
          >
            {message.text}
          </p>
        ) : null}

        {!enabled && !setup ? (
          <div>
            <Button size="sm" onClick={start} disabled={busy || !state}>
              Set up authenticator
            </Button>
          </div>
        ) : null}

        {setup ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-text-main">
              Add this key to your authenticator app (1Password, Authy, Google Authenticator...),
              then enter the 6-digit code it shows.
            </p>
            <div className="rounded border border-elevation-sunken-border px-3 py-2 text-xs">
              <p className="text-text-muted">Setup key</p>
              <p className="mt-1 break-all font-mono text-sm text-text-main">{setup.secret}</p>
              <p className="mt-2 text-text-muted">Or open this link on the device with the app</p>
              <a className="break-all font-mono text-primary" href={setup.otpauthUri}>
                {setup.otpauthUri}
              </a>
            </div>
            <Input
              label="Code from the app"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={enable} disabled={busy || code.trim().length < 6}>
                Turn on
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setSetup(null);
                  setCode("");
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : null}

        {recoveryCodes ? (
          <div className="rounded border border-feedback-warning-border bg-feedback-warning-surface px-3 py-3 text-feedback-warning-foreground">
            <p className="text-sm font-medium">Recovery codes: save them now</p>
            <p className="mt-1 text-xs">
              Each works once if you lose the authenticator. They are shown only this time.
            </p>
            <ul className="mt-2 grid grid-cols-2 gap-1 font-mono text-sm">
              {recoveryCodes.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <Button
              size="sm"
              variant="secondary"
              className="mt-3"
              onClick={() => setRecoveryCodes(null)}
            >
              I saved them
            </Button>
          </div>
        ) : null}

        {enabled && mode === "idle" ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-text-muted">
              {state?.recoveryCodesRemaining ?? 0} recovery code(s) left.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => setMode("regenerate")}>
                New recovery codes
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setMode("disable")}>
                Turn off
              </Button>
            </div>
          </div>
        ) : null}

        {enabled && mode !== "idle" ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-text-main">
              {mode === "disable"
                ? "Enter your password and a current code to turn the second factor off."
                : "Enter a current code to replace your recovery codes. The old ones stop working."}
            </p>
            {mode === "disable" ? (
              <Input
                label="Password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            ) : null}
            <Input
              label="Code from the app"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={mode === "disable" ? disable : regenerate}
                disabled={busy || code.trim().length < 6 || (mode === "disable" && !password)}
              >
                {mode === "disable" ? "Turn off" : "Replace codes"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setMode("idle");
                  setCode("");
                  setPassword("");
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : null}

        <p className="text-xs text-text-muted">
          Lost the app and the codes? On the machine running RedRouter, run{" "}
          <code>red-router reset-password --disable-mfa</code>.
        </p>
      </div>
    </Card>
  );
}
