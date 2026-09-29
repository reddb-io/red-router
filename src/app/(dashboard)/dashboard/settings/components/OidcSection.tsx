"use client";

// Single sign-on for the dashboard: the identity provider, who may sign in, a connection check
// and a real "test sign-in". Password login can only be switched off after a test sign-in has
// worked, so a wrong setting can never lock the operator out.

import { KeyRound } from "lucide-react";
import Icon from "@/shared/components/Icon";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button, Card, Input, Toggle } from "@/shared/components";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const TEST_MESSAGES: Record<string, { ok: boolean; message: string }> = {
  ok: { ok: true, message: "Test sign-in worked. You can now turn password login off." },
  subject_not_allowed: {
    ok: false,
    message: "The provider signed you in, but that account is not on the allow list.",
  },
  invalid_state: { ok: false, message: "The sign-in expired. Start the test again." },
  id_token_invalid: { ok: false, message: "The provider's ID token could not be verified." },
  token_exchange: { ok: false, message: "The provider refused the authorization code." },
  not_configured: { ok: false, message: "OIDC is not enabled or fully configured." },
};

export default function OidcSection() {
  const params = useSearchParams();
  const testResult = params.get("oidc_test");

  const [loaded, setLoaded] = useState(false);
  const [hasPassword, setHasPassword] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [disablePassword, setDisablePassword] = useState(false);
  const [issuer, setIssuer] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [secretSaved, setSecretSaved] = useState(false);
  const [subjects, setSubjects] = useState("");
  const [tested, setTested] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [checks, setChecks] = useState<Check[] | null>(null);

  const load = async () => {
    try {
      const data = await (await fetch("/api/settings")).json();
      setHasPassword(Boolean(data.hasPassword));
      setEnabled(data.oidcEnabled === true);
      setDisablePassword(data.oidcDisablePasswordLogin === true);
      setIssuer(typeof data.oidcIssuer === "string" ? data.oidcIssuer : "");
      setClientId(typeof data.oidcClientId === "string" ? data.oidcClientId : "");
      setSecretSaved(typeof data.oidcClientSecret === "string" && data.oidcClientSecret.length > 0);
      setSubjects(Array.isArray(data.oidcAllowedSubjects) ? data.oidcAllowedSubjects.join("\n") : "");
      setTested(typeof data.oidcLastTestSucceededAt === "string");
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const patch = async (body: Record<string, unknown>, success: string) => {
    setBusy(true);
    setStatus(null);
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(hasPassword ? { ...body, currentPassword } : body),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setStatus({ ok: false, message: data?.error?.message || "Could not save the settings." });
      } else {
        setStatus({ ok: true, message: success });
        setClientSecret("");
        await load();
      }
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    patch(
      {
        oidcIssuer: issuer.trim(),
        oidcClientId: clientId.trim(),
        ...(clientSecret ? { oidcClientSecret: clientSecret } : {}),
        oidcAllowedSubjects: subjects
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
        oidcEnabled: enabled,
      },
      "Saved. Run the connection check and a test sign-in next."
    );

  const checkConnection = async () => {
    setBusy(true);
    setChecks(null);
    try {
      const response = await fetch("/api/auth/oidc/test", { method: "POST" });
      const data = await response.json().catch(() => null);
      setChecks(Array.isArray(data?.checks) ? data.checks : []);
    } finally {
      setBusy(false);
    }
  };

  const banner = testResult ? (TEST_MESSAGES[testResult] ?? { ok: false, message: `Test sign-in failed (${testResult}).` }) : null;

  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 rounded-lg bg-primary/10 text-primary">
          <Icon icon={KeyRound} size="lg" color="current" />
        </div>
        <div>
          <p className="font-medium">Single sign-on (OIDC)</p>
          <p className="text-sm text-text-muted">
            Sign in to the dashboard with your identity provider. Password login stays available
            until you turn it off.
          </p>
        </div>
      </div>

      {banner && (
        <p
          role="status"
          className={`mb-3 text-sm ${banner.ok ? "text-feedback-success-foreground" : "text-feedback-danger-foreground"}`}
        >
          {banner.message}
        </p>
      )}

      <div className="flex flex-col gap-3">
        <Input
          label="Issuer URL"
          placeholder="https://accounts.example.com"
          value={issuer}
          onChange={(event) => setIssuer(event.target.value)}
          disabled={!loaded}
        />
        <Input
          label="Client ID"
          value={clientId}
          onChange={(event) => setClientId(event.target.value)}
          disabled={!loaded}
        />
        <Input
          label="Client secret"
          type="password"
          value={clientSecret}
          placeholder={secretSaved ? "Saved — type to replace" : ""}
          onChange={(event) => setClientSecret(event.target.value)}
          disabled={!loaded}
        />
        <div className="flex flex-col gap-1.5">
          <label htmlFor="oidc-allowed" className="text-sm font-medium text-text-main">
            Who may sign in
          </label>
          <textarea
            id="oidc-allowed"
            rows={3}
            value={subjects}
            onChange={(event) => setSubjects(event.target.value)}
            placeholder={"admin@example.com\none subject or verified e-mail per line"}
            className="rounded border border-control-edge bg-surface px-3 py-2 text-sm text-text-main"
          />
          <p className="text-xs text-text-muted">
            Required to enable OIDC. Only these subjects or verified e-mails are let in.
          </p>
        </div>
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">Enable OIDC sign-in</p>
          <Toggle checked={enabled} onChange={() => setEnabled((value) => !value)} disabled={!loaded} />
        </div>
        {hasPassword && (
          <Input
            label="Current password"
            type="password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            hint="Needed to change sign-in settings."
          />
        )}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={save} disabled={!loaded || busy}>
            Save
          </Button>
          <Button size="sm" variant="secondary" onClick={checkConnection} disabled={!loaded || busy}>
            Check connection
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={!loaded || busy || !enabled}
            onClick={() => {
              window.location.href = "/api/auth/oidc/login?test=1";
            }}
          >
            Test sign-in
          </Button>
        </div>
        {status && (
          <p
            role="status"
            className={`text-sm ${status.ok ? "text-feedback-success-foreground" : "text-feedback-danger-foreground"}`}
          >
            {status.message}
          </p>
        )}
        {checks && (
          <ul className="flex flex-col gap-1 text-sm">
            {checks.map((check) => (
              <li
                key={check.name}
                className={check.ok ? "text-feedback-success-foreground" : "text-feedback-danger-foreground"}
              >
                {check.ok ? "✓" : "✗"} {check.detail}
              </li>
            ))}
          </ul>
        )}

        <div className="mt-2 flex items-center justify-between border-t border-elevation-sunken-border pt-3">
          <div>
            <p className="font-medium">Turn password login off</p>
            <p className="text-sm text-text-muted">
              {tested
                ? "Only OIDC can sign in. If you get locked out, run `red-router reset-password --disable-sso` on this machine."
                : "Available after a successful test sign-in."}
            </p>
          </div>
          <Toggle
            checked={disablePassword}
            onChange={() =>
              patch(
                { oidcDisablePasswordLogin: !disablePassword },
                !disablePassword ? "Password login is off." : "Password login is on."
              )
            }
            disabled={!loaded || busy || (!tested && !disablePassword)}
          />
        </div>
      </div>
    </Card>
  );
}
