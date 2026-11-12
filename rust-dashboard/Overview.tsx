import { useCallback, useEffect, useMemo, useState } from "react";
import {
  listRustClientKeys,
  listRustCombos,
  listRustProviderHealth,
  listRustProviders,
  readRustRuntimeStatus,
  readRustUsageSummary,
  type RustClientKey,
  type RustCombo,
  type RustProvider,
  type RustProviderHealth,
  type RustRuntimeStatus,
  type RustUsageSummary,
} from "./api/browserClient";
import { Button, Card } from "./components";

interface Snapshot {
  runtime: RustRuntimeStatus;
  providers: RustProvider[];
  health: RustProviderHealth[];
  combos: RustCombo[];
  keys: RustClientKey[];
  usage: RustUsageSummary;
}

const emptyUsage: RustUsageSummary = {
  request_count: 0,
  priced_request_count: 0,
  tokens_input: 0,
  tokens_output: 0,
  tokens_cache_read: 0,
  tokens_cache_creation: 0,
  tokens_reasoning: 0,
  amount_microusd: 0,
  pending_request_count: 0,
  pending_reserved_tokens: 0,
  pending_reserved_microusd: 0,
};

function number(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function money(microusd: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    microusd / 1_000_000
  );
}

function Status({ ok, children }: { ok: boolean; children: string }) {
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-medium ${
        ok ? "bg-success/10 text-success" : "bg-error/10 text-error"
      }`}
    >
      <span className={`h-2 w-2 rounded-full ${ok ? "bg-success" : "bg-error"}`} />
      {children}
    </span>
  );
}

export default function Overview() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [runtime, providers, health, combos, keys, usage] = await Promise.all([
        readRustRuntimeStatus(signal),
        listRustProviders(),
        listRustProviderHealth(),
        listRustCombos(),
        listRustClientKeys(),
        readRustUsageSummary(),
      ]);
      if (!signal?.aborted) setSnapshot({ runtime, providers, health, combos, keys, usage });
    } catch (cause) {
      if (!signal?.aborted)
        setError(cause instanceof Error ? cause.message : "Unable to load the Rust control plane.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  const refresh = () => {
    setLoading(true);
    setError("");
    void load();
  };

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const summary = useMemo(() => {
    const providers = snapshot?.providers ?? [];
    const health = snapshot?.health ?? [];
    return {
      enabledProviders: providers.filter((item) => item.enabled).length,
      credentialProblems: providers.filter(
        (item) => !item.has_credential || item.credential_expired || item.reauth_required
      ).length,
      unhealthyProviders: health.filter((item) => item.state !== "closed" || item.terminal_status)
        .length,
      enabledCombos: (snapshot?.combos ?? []).filter((item) => item.enabled).length,
      enabledKeys: (snapshot?.keys ?? []).filter((item) => item.enabled).length,
    };
  }, [snapshot]);

  const usage = snapshot?.usage ?? emptyUsage;
  return (
    <section className="space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Operations overview</h1>
          <p className="mt-1 text-sm text-text-muted">
            Live state from the Rust proxy, control plane and SQLite usage authority.
          </p>
        </div>
        <Button variant="outline" loading={loading} onClick={refresh}>
          Refresh
        </Button>
      </div>

      {error ? (
        <Card className="border-error/40" title="Control plane unavailable">
          <p role="alert" className="text-sm text-error">
            {error}
          </p>
        </Card>
      ) : null}

      <Card
        title="Runtime"
        subtitle="Liveness accepts management traffic; readiness requires a usable provider."
      >
        <div className="flex flex-wrap gap-3">
          <Status ok={snapshot?.runtime.live === true}>
            {snapshot?.runtime.live ? "Rust server live" : "Rust server unavailable"}
          </Status>
          <Status ok={snapshot?.runtime.ready === true}>
            {snapshot?.runtime.ready ? "Proxy ready" : "Proxy not ready"}
          </Status>
          {snapshot?.runtime.checked_at ? (
            <span className="self-center text-xs text-text-muted">
              Checked {new Date(snapshot.runtime.checked_at).toLocaleTimeString()}
            </span>
          ) : null}
        </div>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {[
          ["Active providers", summary.enabledProviders, "/dashboard/providers"],
          [
            "Provider alerts",
            summary.unhealthyProviders + summary.credentialProblems,
            "/dashboard/provider-resilience",
          ],
          ["Active combos", summary.enabledCombos, "/dashboard/combos"],
          ["Active API keys", summary.enabledKeys, "/dashboard/api-manager"],
          ["Requests recorded", usage.request_count, "/dashboard/usage"],
        ].map(([label, value, href]) => (
          <a key={String(label)} href={String(href)} className="block">
            <Card hover className="h-full">
              <p className="text-sm text-text-muted">{label}</p>
              <p className="mt-2 text-3xl font-semibold">{number(Number(value))}</p>
            </Card>
          </a>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Usage" subtitle="Committed native ledger totals for the visible tenant scope.">
          <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-text-muted">Input tokens</dt>
              <dd className="mt-1 font-semibold">{number(usage.tokens_input)}</dd>
            </div>
            <div>
              <dt className="text-text-muted">Output tokens</dt>
              <dd className="mt-1 font-semibold">{number(usage.tokens_output)}</dd>
            </div>
            <div>
              <dt className="text-text-muted">Spend</dt>
              <dd className="mt-1 font-semibold">{money(usage.amount_microusd)}</dd>
            </div>
            <div>
              <dt className="text-text-muted">Pending requests</dt>
              <dd className="mt-1 font-semibold">{number(usage.pending_request_count)}</dd>
            </div>
            <div>
              <dt className="text-text-muted">Reserved tokens</dt>
              <dd className="mt-1 font-semibold">{number(usage.pending_reserved_tokens)}</dd>
            </div>
            <div>
              <dt className="text-text-muted">Reserved spend</dt>
              <dd className="mt-1 font-semibold">{money(usage.pending_reserved_microusd)}</dd>
            </div>
          </dl>
        </Card>

        <Card title="Quick actions" subtitle="All writes go directly to authenticated Rust APIs.">
          <div className="grid gap-3 sm:grid-cols-2">
            {[
              ["Connect provider", "/dashboard/providers"],
              ["Create API key", "/dashboard/api-manager"],
              ["Configure fallback", "/dashboard/combos"],
              ["Review quotas", "/dashboard/provider-resilience"],
              ["Export usage", "/dashboard/usage-sinks"],
              ["Manage organization", "/dashboard/organizations"],
            ].map(([label, href]) => (
              <a
                key={label}
                className="rounded border border-border px-3 py-2 text-sm hover:bg-muted/50"
                href={href}
              >
                {label}
              </a>
            ))}
          </div>
        </Card>
      </div>
    </section>
  );
}
