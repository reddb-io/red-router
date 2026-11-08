"use client";

// Single sign-on for the dashboard: the identity provider, who may sign in, a connection check
// and a real "test sign-in". Password login can only be switched off after a test sign-in has
// worked, so a wrong setting can never lock the operator out.

import { KeyRound } from "lucide-react";
import Icon from "@/shared/components/Icon";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button, Card, Input, Toggle } from "@/shared/components";
import { oidcRequiredClaimsSchema } from "@/shared/validation/oidcPolicy";
import { readRustAuthConfig, rustAdminFetch } from "@/lib/rustControlPlane/browserClient";

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
  claims_not_allowed: {
    ok: false,
    message: "The signed-in account does not meet this server's claim conditions.",
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
  const [rustBackend, setRustBackend] = useState(false);
  const [hasPassword, setHasPassword] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [disablePassword, setDisablePassword] = useState(false);
  const [issuer, setIssuer] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [secretSaved, setSecretSaved] = useState(false);
  const [audience, setAudience] = useState("");
  const [jwksUri, setJwksUri] = useState("");
  const [publicOrigin, setPublicOrigin] = useState("");
  const [authorizationEndpoint, setAuthorizationEndpoint] = useState("");
  const [tokenEndpoint, setTokenEndpoint] = useState("");
  const [scopes, setScopes] = useState("openid\nprofile\nemail");
  const [subjects, setSubjects] = useState("");
  const [requiredClaims, setRequiredClaims] = useState("{}");
  const [claimsError, setClaimsError] = useState<string | null>(null);
  const [tested, setTested] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [checks, setChecks] = useState<Check[] | null>(null);

  const load = useCallback(async () => {
    try {
      const rust = await readRustAuthConfig().catch(() => null);
      if (rust?.backend === "rust") {
        setRustBackend(true);
        setHasPassword(false);
        const response = await rustAdminFetch("/api/admin/oidc");
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error("Rust OIDC settings are unavailable");
        const oidc = data?.oidc;
        const browser = oidc?.browser;
        setEnabled(oidc?.enabled === true);
        setIssuer(typeof oidc?.issuer === "string" ? oidc.issuer : "");
        setAudience(typeof oidc?.audience === "string" ? oidc.audience : "");
        setJwksUri(typeof oidc?.jwks_uri === "string" ? oidc.jwks_uri : "");
        setClientId(typeof browser?.client_id === "string" ? browser.client_id : "");
        setSecretSaved(browser?.has_client_secret === true);
        setPublicOrigin(
          typeof browser?.public_origin === "string" ? browser.public_origin : window.location.origin
        );
        setAuthorizationEndpoint(
          typeof browser?.authorization_endpoint === "string"
            ? browser.authorization_endpoint
            : ""
        );
        setTokenEndpoint(
          typeof browser?.token_endpoint === "string" ? browser.token_endpoint : ""
        );
        setScopes(
          Array.isArray(browser?.scopes) && browser.scopes.length > 0
            ? browser.scopes.join("\n")
            : "openid\nprofile\nemail"
        );
        setSubjects(Array.isArray(oidc?.allowed_subjects) ? oidc.allowed_subjects.join("\n") : "");
        setRequiredClaims(JSON.stringify(oidc?.required_claims ?? {}, null, 2));
        setTested(testResult === "ok");
        return;
      }
      const data = await (await fetch("/api/settings")).json();
      setHasPassword(Boolean(data.hasPassword));
      setEnabled(data.oidcEnabled === true);
      setDisablePassword(data.oidcDisablePasswordLogin === true);
      setIssuer(typeof data.oidcIssuer === "string" ? data.oidcIssuer : "");
      setClientId(typeof data.oidcClientId === "string" ? data.oidcClientId : "");
      setSecretSaved(typeof data.oidcClientSecret === "string" && data.oidcClientSecret.length > 0);
      setSubjects(Array.isArray(data.oidcAllowedSubjects) ? data.oidcAllowedSubjects.join("\n") : "");
      setRequiredClaims(JSON.stringify(data.oidcRequiredClaims ?? {}, null, 2));
      setTested(typeof data.oidcLastTestSucceededAt === "string");
    } catch {
      setStatus({ ok: false, message: "Could not load the OIDC settings." });
    } finally {
      setLoaded(true);
    }
  }, [testResult]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

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

  const save = async () => {
    let value: unknown;
    try {
      value = JSON.parse(requiredClaims);
    } catch {
      setClaimsError("Enter a JSON object with claim names and arrays of allowed values.");
      return;
    }
    const parsed = oidcRequiredClaimsSchema.safeParse(value);
    if (!parsed.success) {
      setClaimsError("Each claim must contain at least one allowed string value.");
      return;
    }
    setClaimsError(null);
    if (rustBackend) {
      setBusy(true);
      setStatus(null);
      try {
        const scopeValues = scopes
          .split(/\s+/)
          .map((scope) => scope.trim())
          .filter(Boolean);
        const response = await rustAdminFetch("/api/admin/oidc", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            enabled,
            issuer: issuer.trim(),
            audience: audience.trim() || clientId.trim(),
            jwks_uri: jwksUri.trim(),
            required_claims: parsed.data,
            allowed_subjects: subjects
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean),
            browser: {
              public_origin: publicOrigin.trim(),
              client_id: clientId.trim(),
              ...(clientSecret ? { client_secret: clientSecret } : {}),
              authorization_endpoint: authorizationEndpoint.trim(),
              token_endpoint: tokenEndpoint.trim(),
              scopes: scopeValues,
            },
          }),
        });
        const data = await response.json().catch(() => null);
        if (!response.ok) {
          setStatus({
            ok: false,
            message: data?.error?.message || "Could not save the Rust OIDC settings.",
          });
        } else {
          setClientSecret("");
          setSecretSaved(data?.oidc?.browser?.has_client_secret === true);
          setStatus({
            ok: true,
            message: "Saved in Rust. Sign in again to activate the new policy revision.",
          });
        }
      } catch {
        setStatus({ ok: false, message: "Could not save the Rust OIDC settings." });
      } finally {
        setBusy(false);
      }
      return;
    }
    return patch(
      {
        oidcIssuer: issuer.trim(),
        oidcClientId: clientId.trim(),
        ...(clientSecret ? { oidcClientSecret: clientSecret } : {}),
        oidcAllowedSubjects: subjects
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
        oidcRequiredClaims: parsed.data,
        oidcEnabled: enabled,
      },
      "Saved. Run the connection check and a test sign-in next."
    );
  };

  const checkConnection = async () => {
    setBusy(true);
    setChecks(null);
    try {
      if (rustBackend) {
        const response = await rustAdminFetch("/api/admin/oidc/discover", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ issuer: issuer.trim() }),
        });
        const data = await response.json().catch(() => null);
        if (!response.ok || !data?.discovery) {
          setChecks([{ name: "discovery", ok: false, detail: "Discovery failed." }]);
          return;
        }
        const discovery = data.discovery;
        setIssuer(discovery.issuer);
        setJwksUri(discovery.jwks_uri);
        setAuthorizationEndpoint(discovery.authorization_endpoint);
        setTokenEndpoint(discovery.token_endpoint);
        const supported = Array.isArray(discovery.scopes_supported)
          ? discovery.scopes_supported
          : [];
        const recommended = ["openid", "profile", "email"].filter(
          (scope) => supported.length === 0 || supported.includes(scope)
        );
        setScopes(recommended.join("\n"));
        setChecks([
          { name: "discovery", ok: true, detail: "Issuer metadata loaded by Rust." },
          { name: "endpoints", ok: true, detail: "Authorization, token and JWKS endpoints are valid." },
        ]);
        return;
      }
      const response = await fetch("/api/auth/oidc/test", { method: "POST" });
      const data = await response.json().catch(() => null);
      setChecks(Array.isArray(data?.checks) ? data.checks : []);
    } catch {
      setChecks([{ name: "connection", ok: false, detail: "Connection check failed." }]);
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
            {rustBackend
              ? "Rust owns discovery, credentials, PKCE sessions and access policy for the static dashboard."
              : "Sign in to the dashboard with your identity provider. Password login stays available until you turn it off."}
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
        {rustBackend && (
          <>
            <Input
              label="Token audience"
              value={audience}
              onChange={(event) => setAudience(event.target.value)}
              hint="Defaults to the browser client ID when left empty."
              disabled={!loaded}
            />
            <Input
              label="Public dashboard origin"
              value={publicOrigin}
              onChange={(event) => setPublicOrigin(event.target.value)}
              placeholder="https://router.example.com"
              disabled={!loaded}
            />
          </>
        )}
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
        {rustBackend && (
          <>
            <Input
              label="Authorization endpoint"
              value={authorizationEndpoint}
              onChange={(event) => setAuthorizationEndpoint(event.target.value)}
              disabled={!loaded}
            />
            <Input
              label="Token endpoint"
              value={tokenEndpoint}
              onChange={(event) => setTokenEndpoint(event.target.value)}
              disabled={!loaded}
            />
            <Input
              label="JWKS endpoint"
              value={jwksUri}
              onChange={(event) => setJwksUri(event.target.value)}
              disabled={!loaded}
            />
            <div className="flex flex-col gap-1.5">
              <label htmlFor="oidc-scopes" className="text-sm font-medium text-text-main">
                Browser scopes
              </label>
              <textarea
                id="oidc-scopes"
                rows={3}
                value={scopes}
                onChange={(event) => setScopes(event.target.value)}
                disabled={!loaded}
                className="rounded border border-control-edge bg-surface px-3 py-2 text-sm text-text-main"
              />
            </div>
          </>
        )}
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
            Optional when claim conditions are configured. Both restrictions apply when both are set.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="oidc-claims" className="text-sm font-medium text-text-main">
            Required claim conditions
          </label>
          <textarea
            id="oidc-claims"
            rows={4}
            value={requiredClaims}
            disabled={!loaded}
            spellCheck={false}
            aria-invalid={Boolean(claimsError)}
            aria-describedby="oidc-claims-help"
            onChange={(event) => {
              setRequiredClaims(event.target.value);
              setClaimsError(null);
            }}
            className="rounded border border-control-edge bg-surface px-3 py-2 text-sm text-text-main"
          />
          <p id="oidc-claims-help" className="text-xs text-text-muted">
            {claimsError || 'All conditions must match the signed ID token. Example: {"role":["owner"]}. Use {} for no claim conditions; an allowed subject is then required.'}
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
            {rustBackend ? "Discover endpoints" : "Check connection"}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={!loaded || busy || !enabled}
            onClick={() => {
              window.location.href = rustBackend
                ? "/api/auth/oidc/login"
                : "/api/auth/oidc/login?test=1";
            }}
          >
            {rustBackend ? "Sign in with saved configuration" : "Test sign-in"}
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

        {!rustBackend && (
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
        )}
      </div>
    </Card>
  );
}
