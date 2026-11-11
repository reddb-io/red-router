import { lazy, Suspense, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { readRustAdminCsrfCookie, readRustAuthConfig, type RustAuthConfig } from "@/lib/rustControlPlane/browserClient";
import "./dashboard.css";

const Providers = lazy(() => import("../src/app/(dashboard)/dashboard/providers/RustProvidersPageClient"));
const Combos = lazy(() => import("../src/app/(dashboard)/dashboard/combos/RustCombosPageClient"));
const Keys = lazy(() => import("../src/app/(dashboard)/dashboard/api-manager/RustApiManagerPageClient"));
const UsageSinks = lazy(() => import("./UsageSinks"));
const UsageReport = lazy(() => import("./UsageReport"));
const OidcSettings = lazy(() => import("./OidcSettings"));
const ModelCatalog = lazy(() => import("./ModelCatalog"));
const LegacyUsage = lazy(() => import("./LegacyUsage"));

const pages = [
  { path: "/dashboard/providers", label: "Providers", component: Providers },
  { path: "/dashboard/model-catalog", label: "Model catalog", component: ModelCatalog },
  { path: "/dashboard/combos", label: "Combos", component: Combos },
  { path: "/dashboard/api-manager", label: "API keys", component: Keys },
  { path: "/dashboard/usage-sinks", label: "Usage destinations", component: UsageSinks },
  { path: "/dashboard/usage", label: "Usage report", component: UsageReport },
  { path: "/dashboard/legacy-usage", label: "Historical usage", component: LegacyUsage },
  { path: "/dashboard/oidc", label: "Single sign-on", component: OidcSettings },
];

function Dashboard() {
  const [config, setConfig] = useState<RustAuthConfig | null | undefined>(undefined);
  const [session, setSession] = useState(() => Boolean(readRustAdminCsrfCookie()));
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    readRustAuthConfig(controller.signal)
      .then(setConfig)
      .catch(() => { if (!controller.signal.aborted) setConfig(null); });
    return () => controller.abort();
  }, []);

  const logout = async () => {
    setError("");
    try {
      const csrf = readRustAdminCsrfCookie();
      const response = await fetch("/api/auth/logout", {
        method: "POST", credentials: "same-origin", headers: csrf ? { "x-red-router-csrf": csrf } : {},
      });
      if (!response.ok) throw new Error("Unable to sign out.");
      setSession(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to sign out.");
    }
  };

  if (config === undefined) return <main className="p-6">Loading RedRouter…</main>;
  if (!config?.control_plane_enabled) return <main className="p-6">Rust control plane is unavailable.</main>;
  if (!session) return (
    <main className="mx-auto max-w-lg p-8">
      <h1 className="text-2xl font-semibold">RedRouter</h1>
      {config.oidc_browser_login ? (
        <button className="mt-6 inline-block rounded bg-primary px-4 py-2 text-white" type="button" onClick={() => window.location.assign("/api/auth/oidc/login")}>Sign in with OpenID Connect</button>
      ) : <p className="mt-4">Configure OpenID Connect browser login in the Rust control plane to use this dashboard.</p>}
    </main>
  );

  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  const current = pages.find((page) => page.path === path) ?? (path === "/" || path === "/dashboard" ? pages[0] : null);
  const Page = current?.component;
  return (
    <div className="min-h-screen bg-bg text-text-main">
      <header className="flex flex-wrap items-center gap-4 border-b border-border px-6 py-4">
        <a href="/dashboard" className="font-semibold">RedRouter</a>
        <nav aria-label="Dashboard" className="flex flex-wrap gap-4">
          {pages.map((page) => <a key={page.path} href={page.path} aria-current={current?.path === page.path ? "page" : undefined}>{page.label}</a>)}
        </nav>
        <button className="ml-auto" type="button" onClick={() => void logout()}>Sign out</button>
      </header>
      {error && <p role="alert" className="p-4 text-error">{error}</p>}
      <main>{Page ? <Suspense fallback={<div className="p-6">Loading…</div>}><Page /></Suspense> : <div className="p-6">Page not available in the Rust dashboard yet.</div>}</main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Dashboard />);
