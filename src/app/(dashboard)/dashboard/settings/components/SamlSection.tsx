"use client";

// SAML 2.0 sign-in for the dashboard: the identity provider's sign-in URL and signing certificate,
// who may sign in, the service-provider details to register at the IdP, a static check and a real
// test sign-in. Password login always stays available next to SAML.

import { ShieldCheck } from "lucide-react";
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
  ok: { ok: true, message: "Test sign-in worked: the identity provider vouched for an allowed e-mail." },
  not_allowed: {
    ok: false,
    message: "The identity provider signed you in, but that e-mail is not on the allow list.",
  },
  invalid_response: {
    ok: false,
    message: "The response was rejected: check the certificate, the audience and the clock.",
  },
  locked: { ok: false, message: "Too many failed attempts. Wait a little and try again." },
  not_configured: { ok: false, message: "SAML is not enabled or fully configured." },
};

export default function SamlSection() {
  const params = useSearchParams();
  const testResult = params.get("saml_test");

  const [loaded, setLoaded] = useState(false);
  const [hasPassword, setHasPassword] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [entryPoint, setEntryPoint] = useState("");
  const [cert, setCert] = useState("");
  const [issuer, setIssuer] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [attribute, setAttribute] = useState("");
  const [emails, setEmails] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [checks, setChecks] = useState<Check[] | null>(null);

  const load = async () => {
    try {
      const data = await (await fetch("/api/settings")).json();
      setHasPassword(Boolean(data.hasPassword));
      setEnabled(data.samlEnabled === true);
      setEntryPoint(typeof data.samlEntryPoint === "string" ? data.samlEntryPoint : "");
      setCert(typeof data.samlCert === "string" ? data.samlCert : "");
      setIssuer(typeof data.samlIssuer === "string" ? data.samlIssuer : "");
      setBaseUrl(typeof data.samlBaseUrl === "string" ? data.samlBaseUrl : "");
      setAttribute(typeof data.samlAttributeEmail === "string" ? data.samlAttributeEmail : "");
      setEmails(Array.isArray(data.samlAllowedEmails) ? data.samlAllowedEmails.join("\n") : "");
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const save = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const body = {
        samlEntryPoint: entryPoint.trim(),
        samlCert: cert.trim(),
        samlIssuer: issuer.trim(),
        samlBaseUrl: baseUrl.trim(),
        samlAttributeEmail: attribute.trim(),
        samlAllowedEmails: emails
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
        samlEnabled: enabled,
      };
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(hasPassword ? { ...body, currentPassword } : body),
      });
      const data = await response.json().catch(() => null);
      setStatus(
        response.ok
          ? { ok: true, message: "Saved. Run the check and a test sign-in next." }
          : { ok: false, message: data?.error?.message || "Could not save the settings." }
      );
      if (response.ok) await load();
    } finally {
      setBusy(false);
    }
  };

  const check = async () => {
    setBusy(true);
    setChecks(null);
    try {
      const data = await (await fetch("/api/auth/saml/test", { method: "POST" })).json();
      setChecks(Array.isArray(data?.checks) ? data.checks : []);
    } finally {
      setBusy(false);
    }
  };

  const banner = testResult
    ? (TEST_MESSAGES[testResult] ?? { ok: false, message: `Test sign-in failed (${testResult}).` })
    : null;
  const origin = baseUrl.trim().replace(/\/+$/, "") || (typeof window !== "undefined" ? window.location.origin : "");

  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 rounded-lg bg-primary/10 text-primary">
          <Icon icon={ShieldCheck} size="lg" color="current" />
        </div>
        <div>
          <p className="font-medium">SAML sign-in</p>
          <p className="text-sm text-text-muted">
            Sign in to the dashboard through a SAML 2.0 identity provider. Password login stays
            available.
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
          label="Identity provider sign-in URL"
          placeholder="https://idp.example.com/sso/saml"
          value={entryPoint}
          onChange={(event) => setEntryPoint(event.target.value)}
          disabled={!loaded}
        />
        <div className="flex flex-col gap-1.5">
          <label htmlFor="saml-cert" className="text-sm font-medium text-text-main">
            Signing certificate
          </label>
          <textarea
            id="saml-cert"
            rows={4}
            value={cert}
            onChange={(event) => setCert(event.target.value)}
            placeholder="-----BEGIN CERTIFICATE-----"
            className="rounded border border-control-edge bg-surface px-3 py-2 font-mono text-xs text-text-main"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="saml-emails" className="text-sm font-medium text-text-main">
            Who may sign in
          </label>
          <textarea
            id="saml-emails"
            rows={3}
            value={emails}
            onChange={(event) => setEmails(event.target.value)}
            placeholder={"admin@example.com\none e-mail per line"}
            className="rounded border border-control-edge bg-surface px-3 py-2 text-sm text-text-main"
          />
          <p className="text-xs text-text-muted">
            Required to enable SAML. Only these e-mails are let in, whoever the provider signs in.
          </p>
        </div>
        <Input
          label="Public address of this dashboard"
          placeholder="https://router.example.com"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          hint="Used to build the address the identity provider posts back to. Set it when RedRouter sits behind a proxy."
          disabled={!loaded}
        />
        <Input
          label="Entity ID (issuer)"
          placeholder="urn:red-router:sp"
          value={issuer}
          onChange={(event) => setIssuer(event.target.value)}
          disabled={!loaded}
        />
        <Input
          label="E-mail attribute"
          placeholder="email"
          value={attribute}
          onChange={(event) => setAttribute(event.target.value)}
          hint="Optional. The assertion attribute that carries the e-mail; the usual ones are tried otherwise."
          disabled={!loaded}
        />
        <div className="rounded border border-elevation-sunken-border px-3 py-2 text-xs text-text-muted">
          <p>Register these at your identity provider:</p>
          <p className="mt-1 font-mono">ACS URL: {origin}/api/auth/saml/acs</p>
          <p className="font-mono">Entity ID: {issuer.trim() || "urn:red-router:sp"}</p>
          <p className="font-mono">Metadata: {origin}/api/auth/saml/metadata</p>
        </div>
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">Enable SAML sign-in</p>
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
          <Button size="sm" variant="secondary" onClick={check} disabled={!loaded || busy}>
            Check setup
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={!loaded || busy || !enabled}
            onClick={() => {
              window.location.href = "/api/auth/saml/start?test=1";
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
            {checks.map((item) => (
              <li
                key={item.name}
                className={item.ok ? "text-feedback-success-foreground" : "text-feedback-danger-foreground"}
              >
                {item.ok ? "✓" : "✗"} {item.detail}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
