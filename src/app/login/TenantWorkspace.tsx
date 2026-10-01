"use client";

import { useEffect, useState } from "react";
import { Button, Input, Select } from "@/shared/components";
import { errorText } from "../(dashboard)/dashboard/tenants/tenantsTypes";
import type { TenantApiKeyRow, TenantUser } from "@/lib/db/tenants";
import type { getTenantMonthlyUsage } from "@/lib/db/tenantUsage";
import type { RoutingPolicy } from "@/lib/routing/routingPolicy";

type Usage = ReturnType<typeof getTenantMonthlyUsage>;
type Routing = {
  effective: RoutingPolicy;
  locked: { transparent: boolean; priority: boolean };
  choice: { transparent: boolean | null; priority: string[] | null };
  providers: { id: string; name: string; connections: number }[];
};
type Pane = "usage" | "keys" | "users" | "routing";
const panes: { id: Pane; label: string }[] = [
  { id: "usage", label: "Monthly usage" },
  { id: "keys", label: "API keys" },
  { id: "users", label: "Members" },
  { id: "routing", label: "Routing" },
];
const amount = (value: number | null) => (value === null ? "Unknown" : `$${value.toFixed(6)}`);

/** Tenant-only APIs. The owner workspace and its credentials are never used here. */
export default function TenantWorkspace({ role }: { role: string }) {
  const [pane, setPane] = useState<Pane>("usage");
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [generation, setGeneration] = useState(0);
  const [data, setData] = useState<{
    usage?: Usage;
    keys?: TenantApiKeyRow[];
    users?: TenantUser[];
    routing?: Routing;
  } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (role !== "admin") return;
    const controller = new AbortController();
    setData(null);
    setError("");
    const suffix = pane === "usage" ? `?month=${encodeURIComponent(month)}` : "";
    void fetch(`/api/tenant/${pane}${suffix}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok)
          throw new Error(
            errorText(body, "Unable to load tenant data. Sign in again if your session expired.")
          );
        if (!controller.signal.aborted) setData(pane === "routing" ? { routing: body } : body);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : "Unable to load tenant data.");
      });
    return () => controller.abort();
  }, [pane, month, generation, role]);
  if (role !== "admin")
    return (
      <p className="text-sm text-text-muted">
        Your account is active. Ask a tenant admin for API access, usage reports or routing changes.
      </p>
    );
  return (
    <div className="space-y-6">
      <nav
        aria-label="Tenant workspace"
        className="flex flex-wrap gap-2 border-b border-border pb-3"
      >
        {panes.map((item) => (
          <Button
            key={item.id}
            variant={pane === item.id ? "primary" : "ghost"}
            aria-pressed={pane === item.id}
            onClick={() => setPane(item.id)}
          >
            {item.label}
          </Button>
        ))}
      </nav>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-xl font-semibold text-text-main">
          {panes.find((item) => item.id === pane)?.label}
        </h2>
        <Button variant="ghost" onClick={() => setGeneration((n) => n + 1)}>
          Refresh
        </Button>
      </div>
      {pane === "usage" && (
        <div className="max-w-xs">
          <Input
            label="Reporting month (UTC)"
            type="month"
            value={month}
            onChange={(event) => {
              if (event.target.value) setMonth(event.target.value);
            }}
          />
        </div>
      )}
      {error ? (
        <p role="alert" className="text-feedback-danger-foreground">
          {error}
        </p>
      ) : !data ? (
        <p role="status" className="text-sm text-text-muted">
          Loading tenant data…
        </p>
      ) : (
        <>
          {data.usage && (
            <>
              <dl className="flex flex-wrap gap-x-8 gap-y-3 text-sm">
                <div>
                  <dt className="text-text-muted">Requests</dt>
                  <dd>{data.usage.total.requests.toLocaleString()}</dd>
                </div>
                <div>
                  <dt className="text-text-muted">Errors</dt>
                  <dd>{data.usage.total.errors.toLocaleString()}</dd>
                </div>
                <div>
                  <dt className="text-text-muted">Tokens</dt>
                  <dd>
                    {(
                      data.usage.total.inputTokens + data.usage.total.outputTokens
                    ).toLocaleString()}
                  </dd>
                </div>
                <div>
                  <dt className="text-text-muted">Recorded cost</dt>
                  <dd>{amount(data.usage.reconciliation.total.recordedCostUsd)}</dd>
                </div>
              </dl>
              <p className="max-w-prose text-sm text-text-muted">{data.usage.coverage}</p>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <caption className="sr-only">Usage by API key for {month}</caption>
                  <thead>
                    <tr>
                      <th className="py-2">API key</th>
                      <th>Requests</th>
                      <th>Errors</th>
                      <th>Tokens</th>
                      <th>Recorded cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.usage.reconciliation.keys.map((row) => (
                      <tr key={row.apiKeyId ?? "unattributed"} className="border-t border-border">
                        <td className="py-3">
                          {row.name}
                          {!row.current && " (historical)"}
                        </td>
                        <td>{row.requests}</td>
                        <td>{row.errors}</td>
                        <td>{row.inputTokens + row.outputTokens}</td>
                        <td>{amount(row.recordedCostUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!data.usage.keys.length && (
                <p className="text-sm text-text-muted">No keys or retained usage in this month.</p>
              )}
            </>
          )}
          {data.keys && (
            <>
              <p className="text-sm text-text-muted">
                Keys are masked. Ask the instance owner to create, rotate or revoke keys.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <caption className="sr-only">API keys for your tenant</caption>
                  <thead>
                    <tr>
                      <th className="py-2">Name</th>
                      <th>Prefix</th>
                      <th>Status</th>
                      <th>Last used</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.keys.map((row) => (
                      <tr key={row.id} className="border-t border-border">
                        <td className="py-3">{row.name}</td>
                        <td className="font-mono">{row.prefix ? `${row.prefix}…` : "Hidden"}</td>
                        <td>
                          {!row.isActive
                            ? "Disabled"
                            : row.expiresAt && new Date(row.expiresAt) <= new Date()
                              ? "Expired"
                              : "Active"}
                        </td>
                        <td>
                          {row.lastUsedAt ? new Date(row.lastUsedAt).toLocaleString() : "Never"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!data.keys.length && (
                <p className="text-sm text-text-muted">
                  No API keys assigned. Ask the instance owner to add a key to this tenant.
                </p>
              )}
            </>
          )}
          {data.users && (
            <>
              <p className="text-sm text-text-muted">
                The instance owner manages invitations and member roles.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <caption className="sr-only">Members of your tenant</caption>
                  <thead>
                    <tr>
                      <th className="py-2">Email</th>
                      <th>Name</th>
                      <th>Role</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.users.map((row) => (
                      <tr key={row.id} className="border-t border-border">
                        <td className="py-3">{row.email}</td>
                        <td>{row.displayName || "—"}</td>
                        <td>{row.role}</td>
                        <td>
                          {row.disabled
                            ? "Disabled"
                            : row.hasPassword
                              ? "Active"
                              : "Invitation pending"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {data.routing && (
            <TenantRouting
              key={generation}
              state={data.routing}
              onSaved={() => setGeneration((n) => n + 1)}
            />
          )}
        </>
      )}
    </div>
  );
}

function TenantRouting({ state, onSaved }: { state: Routing; onSaved: () => void }) {
  const [mode, setMode] = useState(
    state.choice.transparent === null
      ? "inherit"
      : state.choice.transparent
        ? "transparent"
        : "router"
  );
  const [priority, setPriority] = useState(
    state.choice.priority ?? state.effective.providerPriority
  );
  const [inheritOrder, setInheritOrder] = useState(state.choice.priority === null);
  const [modeChanged, setModeChanged] = useState(false);
  const [orderChanged, setOrderChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const known = new Set(state.providers.map((p) => p.id));
  const ordered = [
    ...priority.filter((id) => known.has(id)),
    ...state.providers.map((p) => p.id).filter((id) => !priority.includes(id)),
  ];
  const move = (index: number, delta: number) => {
    const next = [...ordered];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    setPriority(next);
    setInheritOrder(false);
    setOrderChanged(true);
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/tenant/routing", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(!state.locked.transparent && modeChanged
            ? { transparent: mode === "inherit" ? null : mode === "transparent" }
            : {}),
          ...(!state.locked.priority && orderChanged
            ? { priority: inheritOrder ? null : priority }
            : {}),
        }),
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(
          errorText(body, "Unable to save routing. The owner may have changed delegation.")
        );
      onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to save routing.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={save} className="space-y-5">
      <p className="text-sm text-text-muted">
        Effective mode:{" "}
        {state.effective.transparent ? "Provider prefixes visible" : "Router chooses provider"} (
        {state.effective.source.transparent}). The owner can lock either setting.
      </p>
      <Select
        label="Model visibility"
        value={mode}
        disabled={state.locked.transparent || busy}
        options={[
          { value: "inherit", label: "Use instance default" },
          { value: "transparent", label: "Show provider prefixes" },
          { value: "router", label: "Hide provider prefixes" },
        ]}
        onChange={(event) => {
          setMode(event.target.value);
          setModeChanged(true);
        }}
      />
      {state.locked.transparent && (
        <p className="text-sm text-text-muted">
          Model visibility is controlled by the instance owner.
        </p>
      )}
      <fieldset disabled={state.locked.priority || busy} className="space-y-3">
        <legend className="text-sm font-medium">Provider priority</legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={inheritOrder}
            onChange={(event) => {
              setInheritOrder(event.target.checked);
              setOrderChanged(true);
            }}
          />
          Use instance default order
        </label>
        <ol className="space-y-2">
          {ordered.map((id, index) => (
            <li
              key={id}
              className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-2"
            >
              <span>
                {index + 1}. {state.providers.find((p) => p.id === id)?.name || id}
              </span>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={index === 0}
                  aria-label={`Move ${id} up`}
                  onClick={() => move(index, -1)}
                >
                  Up
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={index === ordered.length - 1}
                  aria-label={`Move ${id} down`}
                  onClick={() => move(index, 1)}
                >
                  Down
                </Button>
              </div>
            </li>
          ))}
        </ol>
      </fieldset>
      <p className="text-sm text-text-muted">
        {state.locked.priority
          ? "Provider priority is controlled by the instance owner."
          : "The first available provider is tried first when prefixes are hidden."}{" "}
        Effective source: {state.effective.source.providerPriority}.
      </p>
      {error && (
        <p role="alert" className="text-feedback-danger-foreground">
          {error}
        </p>
      )}
      <Button type="submit" loading={busy} disabled={!modeChanged && !orderChanged}>
        Save routing
      </Button>
    </form>
  );
}
