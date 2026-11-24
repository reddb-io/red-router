import {
  lazy,
  Suspense,
  useEffect,
  useState,
  type ComponentType,
  type FormEvent,
  type ReactNode,
} from "react";
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
const Endpoints = lazy(() => import("./Endpoints"));
const Playground = lazy(() => import("./Playground"));
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
  endpoints: Endpoints,
  playground: Playground,
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

interface NavigationArea {
  id: string;
  label: string;
  description: string;
  icon: string;
  pages: readonly SpaPageId[];
}

const navigationAreas: readonly NavigationArea[] = [
  {
    id: "home",
    label: "Home",
    description: "Runtime overview",
    icon: "space_dashboard",
    pages: ["overview"],
  },
  {
    id: "routing",
    label: "Routing",
    description: "Providers, models and fallback",
    icon: "alt_route",
    pages: ["endpoints", "providers", "resilience", "models", "combos"],
  },
  {
    id: "access",
    label: "Access",
    description: "Clients, budgets and tenants",
    icon: "vpn_key",
    pages: ["keys", "budgets", "organizations"],
  },
  {
    id: "observe",
    label: "Observe",
    description: "Usage, exports and audit",
    icon: "monitoring",
    pages: ["usage", "legacy-usage", "usage-sinks", "audit"],
  },
  {
    id: "tools",
    label: "Tools",
    description: "Test your gateway",
    icon: "build",
    pages: ["playground"],
  },
  {
    id: "system",
    label: "System",
    description: "Authentication and security",
    icon: "settings",
    pages: ["oidc"],
  },
] as const;

const pageIcons: Record<SpaPageId, string> = {
  overview: "space_dashboard",
  endpoints: "cable",
  playground: "science",
  providers: "dns",
  resilience: "health_and_safety",
  models: "database",
  combos: "account_tree",
  keys: "vpn_key",
  budgets: "payments",
  "usage-sinks": "output",
  usage: "monitoring",
  "legacy-usage": "query_stats",
  organizations: "business",
  audit: "policy",
  oidc: "settings_account_box",
};

function NavIcon({ name, className = "" }: { name: string; className?: string }) {
  return (
    <span className={`material-symbols-outlined select-none text-[20px] leading-none ${className}`} aria-hidden="true">
      {name}
    </span>
  );
}

function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <a
      href="/dashboard"
      className={`group flex items-center ${compact ? "justify-center" : "gap-3"}`}
      aria-label="RedRouter home"
    >
      <span className="relative flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-sm font-black text-white shadow-sm shadow-primary/20">
        R
      </span>
      {!compact && (
        <span className="min-w-0">
          <span className="block truncate text-sm font-bold tracking-tight text-foreground">
            RedRouter
          </span>
          <span className="block text-[10px] font-medium uppercase tracking-[0.18em] text-ink-muted">
            AI gateway
          </span>
        </span>
      )}
    </a>
  );
}

function AreaRail({
  selectedId,
  onSelect,
}: {
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <nav
      aria-label="Product areas"
      className="flex h-full w-[68px] shrink-0 flex-col items-center border-e border-elevation-sunken-border bg-elevation-sunken-surface px-2 py-3"
    >
      <BrandMark compact />
      <div className="my-4 h-px w-8 bg-elevation-sunken-border" />
      <ul className="flex w-full flex-1 list-none flex-col items-center gap-1.5 p-0">
        {navigationAreas.map((area) => {
          const selected = area.id === selectedId;
          return (
            <li key={area.id} className="w-full">
              <button
                type="button"
                aria-label={area.label}
                aria-pressed={selected}
                title={area.label}
                onClick={() => onSelect(area.id)}
                className={`relative flex size-11 w-full items-center justify-center rounded-lg border-s-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                  selected
                    ? "border-primary bg-foreground/10 text-foreground"
                    : "border-transparent text-ink-muted hover:bg-foreground/8 hover:text-foreground"
                }`}
              >
                <NavIcon name={area.icon} />
                {selected && (
                  <span className="absolute -start-0.5 top-2 bottom-2 w-0.5 rounded-full bg-primary" />
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function NavigationPanel({
  area,
  currentId,
  onNavigate,
}: {
  area: NavigationArea;
  currentId: SpaPageId | null;
  onNavigate?: () => void;
}) {
  return (
    <aside
      aria-label="Dashboard navigation"
      className="flex h-full w-[264px] shrink-0 flex-col border-e border-elevation-sunken-border bg-elevation-sunken-surface"
    >
      <div className="border-b border-elevation-sunken-border px-5 pb-4 pt-5">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-muted">
          Workspace
        </p>
        <h2 className="mt-1 text-lg font-semibold text-foreground">{area.label}</h2>
        <p className="mt-1 text-xs leading-5 text-ink-muted">{area.description}</p>
      </div>
      <nav aria-label={`${area.label} pages`} className="custom-scrollbar min-h-0 flex-1 overflow-y-auto p-3">
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {area.pages.map((pageId) => {
            const page = spaPageRoutes.find((candidate) => candidate.id === pageId)!;
            const selected = currentId === pageId;
            return (
              <li key={page.id}>
                <a
                  href={page.path}
                  onClick={onNavigate}
                  aria-current={selected ? "page" : undefined}
                  className={`group relative flex min-h-10 items-center gap-3 rounded-lg border-s-2 px-3 py-2 text-[13px] font-medium transition-colors ${
                    selected
                      ? "border-primary bg-elevation-base-surface text-foreground shadow-sm"
                      : "border-transparent text-ink-muted hover:bg-foreground/8 hover:text-foreground"
                  }`}
                >
                  <NavIcon name={pageIcons[pageId]} className="shrink-0 text-[18px]" />
                  <span className="min-w-0 flex-1 truncate">{page.label}</span>
                  {selected && <NavIcon name="chevron_right" className="text-[17px] text-primary" />}
                </a>
              </li>
            );
          })}
        </ul>
      </nav>
    </aside>
  );
}

function DashboardShell({
  currentId,
  onSignOut,
  error,
  children,
}: {
  currentId: SpaPageId | null;
  onSignOut: () => void;
  error: string;
  children: ReactNode;
}) {
  const currentArea =
    navigationAreas.find((area) => currentId && area.pages.includes(currentId)) ??
    navigationAreas[0];
  const [selectedAreaId, setSelectedAreaId] = useState(currentArea.id);
  const [panelOpen, setPanelOpen] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);
  const selectedArea =
    navigationAreas.find((area) => area.id === selectedAreaId) ?? currentArea;
  const currentPage = spaPageRoutes.find((page) => page.id === currentId);

  return (
    <div className="flex h-dvh min-h-0 w-full overflow-hidden bg-elevation-base-surface text-foreground">
      <div className="hidden h-full shrink-0 md:flex">
        <AreaRail
          selectedId={selectedArea.id}
          onSelect={(id) => {
            setSelectedAreaId(id);
            setPanelOpen(true);
          }}
        />
        <div
          className={`h-full overflow-hidden transition-[width] duration-200 motion-reduce:transition-none ${
            panelOpen ? "w-[264px]" : "w-0"
          }`}
        >
          <NavigationPanel area={selectedArea} currentId={currentId} />
        </div>
      </div>

      {mobileOpen && (
        <div className="fixed inset-0 z-50 flex md:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-black/35 backdrop-blur-[2px]"
            aria-label="Close navigation"
            onClick={() => setMobileOpen(false)}
          />
          <div className="relative z-10 flex h-full max-w-[calc(100vw-2rem)] shadow-2xl">
            <AreaRail selectedId={selectedArea.id} onSelect={setSelectedAreaId} />
            <NavigationPanel
              area={selectedArea}
              currentId={currentId}
              onNavigate={() => setMobileOpen(false)}
            />
            <button
              type="button"
              aria-label="Close navigation"
              onClick={() => setMobileOpen(false)}
              className="absolute end-3 top-3 rounded-md p-1.5 text-ink-muted hover:bg-foreground/8 hover:text-foreground"
            >
              <NavIcon name="close" />
            </button>
          </div>
        </div>
      )}

      <main id="main-content" className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center gap-3 border-b border-elevation-sunken-border bg-elevation-base-surface/95 px-4 backdrop-blur sm:px-6">
          <button
            type="button"
            className="rounded-lg p-2 text-ink-muted hover:bg-foreground/8 hover:text-foreground md:hidden"
            aria-label="Open navigation"
            onClick={() => setMobileOpen(true)}
          >
            <NavIcon name="menu" />
          </button>
          <button
            type="button"
            className="hidden rounded-lg p-2 text-ink-muted hover:bg-foreground/8 hover:text-foreground md:inline-flex"
            aria-label={panelOpen ? "Collapse side menu" : "Expand side menu"}
            aria-pressed={panelOpen}
            onClick={() => setPanelOpen((open) => !open)}
          >
            {panelOpen ? (
              <NavIcon name="chevron_left" />
            ) : (
              <NavIcon name="chevron_right" />
            )}
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-ink-muted">
              <span>{currentArea.label}</span>
              <NavIcon name="chevron_right" className="text-[14px]" />
              <span className="truncate text-foreground">{currentPage?.label ?? "Dashboard"}</span>
            </div>
          </div>
          <button
            className="inline-flex items-center gap-2 rounded-lg border border-elevation-sunken-border px-3 py-2 text-xs font-medium text-ink-muted transition-colors hover:bg-foreground/8 hover:text-foreground"
            type="button"
            onClick={onSignOut}
          >
            <NavIcon name="logout" className="text-[18px]" />
            <span className="hidden sm:inline">Sign out</span>
          </button>
        </header>

        {error && (
          <p role="alert" className="border-b border-feedback-danger/30 bg-feedback-danger/10 px-6 py-3 text-sm text-feedback-danger-foreground">
            {error}
          </p>
        )}
        <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-4 sm:p-6 lg:p-8">
          <div className="mx-auto w-full max-w-[1920px]">{children}</div>
        </div>
      </main>
    </div>
  );
}

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
    return <main className="p-6">Management interface is unavailable.</main>;
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
          <p className="mt-4">Configure a management login to use this dashboard.</p>
        ) : null}
      </main>
    );

  const current = resolveSpaPage(window.location.pathname);
  const Page = current ? pageComponents[current.id] : null;
  return (
    <DashboardShell
      currentId={current?.id ?? null}
      onSignOut={() => void logout()}
      error={error}
    >
      {Page ? (
        <Suspense fallback={<div className="p-6">Loading…</div>}>
          <Page />
        </Suspense>
      ) : (
        <div className="p-6">This page is not available yet.</div>
      )}
    </DashboardShell>
  );
}

createRoot(document.getElementById("root")!).render(<Dashboard />);
