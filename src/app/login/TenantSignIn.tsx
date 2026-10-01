"use client";

import { useEffect, useState } from "react";
import TenantWorkspace from "./TenantWorkspace";
import { Button, Input } from "@/shared/components";
import { errorText } from "../(dashboard)/dashboard/tenants/tenantsTypes";

type Identity = {
  user: { id: string; email: string; role: string };
  tenant: { name: string };
  capabilities: { description: string }[];
};
export default function TenantSignIn({ token }: { token: string | null }) {
  const [invite, setInvite] = useState(token);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [restoring, setRestoring] = useState(!token);
  useEffect(() => {
    if (token) return;
    const controller = new AbortController();
    void fetch("/api/tenant/me", { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (response.ok && !controller.signal.aborted) setIdentity(await response.json());
      })
      .catch(() => {})
      .finally(() => {
        if (!controller.signal.aborted) setRestoring(false);
      });
    return () => controller.abort();
  }, [token]);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    setNotice("");
    if (invite && password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const path = invite ? "tenant/accept-invite" : mfaToken ? "mfa/verify" : "tenant/login";
      const body = invite
        ? { token: invite, password }
        : mfaToken
          ? { mfaToken, ...(recovery ? { recoveryCode: code } : { code }) }
          : { email, password };
      const res = await fetch(`/api/auth/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.restart) setMfaToken(null);
        throw new Error(errorText(data, "Unable to sign in."));
      }
      if (invite) {
        setInvite(null);
        setPassword("");
        setConfirm("");
        window.history.replaceState(null, "", "/login#tenant");
        setNotice("Password set. Sign in with the email that received your invitation.");
      } else if (data.mfaRequired) {
        setMfaToken(data.mfaToken);
        setPassword("");
      } else {
        const me = await fetch("/api/tenant/me");
        const result = await me.json();
        if (!me.ok) throw new Error(errorText(result, "Unable to load your account."));
        setIdentity(result);
        setPassword("");
        setCode("");
        setMfaToken(null);
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to sign in.");
    } finally {
      setBusy(false);
    }
  };
  const logout = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/tenant/logout", { method: "POST" });
      if (!res.ok) throw new Error("Unable to sign out.");
      setIdentity(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to sign out.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <main
      className={`mx-auto flex min-h-screen flex-col gap-5 px-6 py-12 ${identity ? "max-w-5xl" : "max-w-md justify-center"}`}
    >
      <div>
        <h1 className="text-2xl font-semibold text-text-main">
          {identity ? identity.tenant.name : invite ? "Accept your invitation" : "Tenant sign-in"}
        </h1>
        <p className="mt-2 text-sm text-text-muted">
          {identity
            ? `${identity.user.email} · ${identity.user.role}`
            : invite
              ? "Set a password for your tenant account. This invitation works once."
              : "Use your tenant email and password."}
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-feedback-danger-foreground">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-text-muted">
          {notice}
        </p>
      )}
      {identity ? (
        <>
          <TenantWorkspace key={identity.user.id} role={identity.user.role} />
          <Button onClick={logout} loading={busy}>
            Sign out
          </Button>
        </>
      ) : restoring ? (
        <p role="status" className="text-sm text-text-muted">
          Checking your tenant session…
        </p>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4">
          {!invite && !mfaToken && (
            <Input
              label="Email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          )}
          {mfaToken ? (
            <>
              <Input
                label={recovery ? "Recovery code" : "Authentication code"}
                autoComplete="one-time-code"
                required
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setRecovery(!recovery);
                  setCode("");
                }}
              >
                {recovery ? "Use authentication code" : "Use recovery code"}
              </Button>
            </>
          ) : (
            <Input
              label={invite ? "New password" : "Password"}
              type="password"
              required
              autoComplete={invite ? "new-password" : "current-password"}
              minLength={invite ? 12 : undefined}
              maxLength={200}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              hint={invite ? "Use at least 12 characters and avoid common passwords." : undefined}
            />
          )}
          {invite && (
            <Input
              label="Confirm password"
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
            />
          )}
          <Button type="submit" loading={busy}>
            {invite ? "Set password" : mfaToken ? "Verify" : "Sign in"}
          </Button>
        </form>
      )}
      <a href="/login" className="text-sm text-text-muted underline underline-offset-4">
        Instance sign-in
      </a>
    </main>
  );
}
