import { lazy, Suspense, useEffect, useState, type ComponentType, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import {
  createRustAdminSession,
  readRustAdminCsrfCookie,
  readRustAuthConfig,
  type RustAuthConfig,
} from "./api/browserClient";
import "./dashboard.css";
import { resolveSpaPage, spaPageRoutes, type SpaPageId } from "./routes";

const Overview = lazy(() => import("./Overview"));
const Providers = lazy(() => import("./pages/RustProvidersPageClient"));
const Combos = lazy(() => import("./pages/RustCombosPageClient"));
const Keys = lazy(() => import("./pages/RustApiManagerPageClient"));
const SharedBudgets = lazy(() => import("./SharedBudgets"));
const UsageSinks = lazy(() => import("./UsageSinks"));
const UsageReport = lazy(() => import("./UsageReport"));
const OidcSettings = lazy(() => import("./OidcSettings"));
const ModelCatalog = lazy(() => import("./ModelCatalog"));
const LegacyUsage = lazy(() => import("./LegacyUsage"));
const Organizations = lazy(() => import("./Organizations"));
const AuditLog = lazy(() => import("./AuditLog"));
const ProviderResilience = lazy(() => import("./ProviderResilience"));

const pageComponents: Record<SpaPageId, ComponentType> = {
  overview: Overview,
  providers: Providers,
  resilience: ProviderResilience,
  models: ModelCatalog,
  combos: Combos,
  keys: Keys,
  budgets: SharedBudgets,
  "usage-sinks": UsageSinks,
  usage: UsageReport,
  "legacy-usage": LegacyUsage,
  organizations: Organizations,
  audit: AuditLog,
  oidc: OidcSettings,
};

function Dashboard() {
  const [config, setConfig] = useState<RustAuthConfig | null | undefined>(undefined);
  const [session, setSession] = useState(() => Boolean(readRustAdminCsrfCookie()));
  const [adminKey, setAdminKey] = useState("");
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    readRustAuthConfig(controller.signal)
      .then(setConfig)
      .catch(() => {
        if (!controller.signal.aborted) setConfig(null);
      });
    return () => controller.abort();
  }, []);

  const logout = async () => {
    setError("");
    try {
      const csrf = readRustAdminCsrfCookie();
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
        headers: csrf ? { "x-red-router-csrf": csrf } : {},
      });
      if (!response.ok) throw new Error("Unable to sign out.");
      setSession(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to sign out.");
    }
  };

  const signIn = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSigningIn(true);
    setError("");
    try {
      await createRustAdminSession(adminKey);
      setAdminKey("");
      setSession(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to sign in.");
    } finally {
      setSigningIn(false);
    }
  };

  if (config === undefined) return <main className="p-6">Loading RedRouter…</main>;
  if (!config?.control_plane_enabled)
    return <main className="p-6">Rust control plane is unavailable.</main>;
  if (!session)
    return (
      <main className="mx-auto max-w-lg p-8">
        <h1 className="text-2xl font-semibold">RedRouter</h1>
        {error && (
          <p role="alert" className="mt-4 text-error">
            {error}
          </p>
        )}
        {config.oidc_browser_login ? (
          <button
            className="mt-6 inline-block rounded bg-primary px-4 py-2 text-white"
            type="button"
            onClick={() => window.location.assign("/api/auth/oidc/login")}
          >
            Sign in with OpenID Connect
          </button>
        ) : null}
        {config.password_login ? (
          <form className="mt-6 space-y-4" onSubmit={(event) => void signIn(event)}>
            <label className="block">
              Administrator key
              <input
                className="mt-1 w-full rounded border border-border bg-surface px-3 py-2"
                type="password"
                autoComplete="current-password"
                minLength={32}
                maxLength={512}
                required
                value={adminKey}
                onChange={(event) => setAdminKey(event.target.value)}
              />
            </label>
            <button type="submit" disabled={signingIn || adminKey.length < 32}>
              {signingIn ? "Signing in…" : "Sign in locally"}
            </button>
          </form>
        ) : !config.oidc_browser_login ? (
          <p className="mt-4">Configure a Rust management login to use this dashboard.</p>
        ) : null}
      </main>
    );

  const current = resolveSpaPage(window.location.pathname);
  const Page = current ? pageComponents[current.id] : null;
  return (
    <div className="min-h-screen bg-bg text-text-main">
      <header className="flex flex-wrap items-center gap-4 border-b border-border px-6 py-4">
        <a href="/dashboard" className="font-semibold">
          RedRouter
        </a>
        <nav aria-label="Dashboard" className="flex flex-wrap gap-4">
          {spaPageRoutes.map((page) => (
            <a
              key={page.path}
              href={page.path}
              aria-current={current?.id === page.id ? "page" : undefined}
            >
              {page.label}
            </a>
          ))}
        </nav>
        <button className="ml-auto" type="button" onClick={() => void logout()}>
          Sign out
        </button>
      </header>
      {error && (
        <p role="alert" className="p-4 text-error">
          {error}
        </p>
      )}
      <main>
        {Page ? (
          <Suspense fallback={<div className="p-6">Loading…</div>}>
            <Page />
          </Suspense>
        ) : (
          <div className="p-6">Page not available in the Rust dashboard yet.</div>
        )}
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Dashboard />);
