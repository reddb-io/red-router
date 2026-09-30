"use client";

// Model visibility: whether clients see `provider/model` (transparent, the default) or bare model
// names, in which case the router picks the provider from the order set here. The owner has the last
// word: a tenant's own choice counts only while it is delegated, and never over what is pinned below.

import { ArrowDown, ArrowUp, Eye, Plus, X } from "lucide-react";
import Icon from "@/shared/components/Icon";
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, Select, Toggle } from "@/shared/components";
import {
  addItem,
  moveItem,
  removeItem,
  sameOrder,
  unlisted,
  type ProviderOption,
} from "./providerPriorityList";

interface Policy {
  transparent: boolean;
  providerPriority: string[];
  delegated: boolean;
}

interface TenantRow {
  id: string;
  slug: string;
  name: string;
  isDefault: boolean;
  ownerPin: { transparent: boolean | null; providerPriority: string[] | null };
  tenantChoice: { transparent: boolean | null; providerPriority: string[] | null };
  effective: {
    transparent: boolean;
    providerPriority: string[];
    source: { transparent: string; providerPriority: string };
  };
}

const JSON_HEADERS = { "Content-Type": "application/json" };

function errorText(data: unknown, fallback: string): string {
  const error = (data as { error?: unknown } | null)?.error;
  if (typeof error === "string") return error;
  const message = (error as { message?: unknown } | undefined)?.message;
  return typeof message === "string" && message ? message : fallback;
}

/** An ordered list with move, remove and add: the first provider is tried first. */
function OrderEditor({
  order,
  providers,
  onChange,
  label,
}: {
  order: string[];
  providers: ProviderOption[];
  onChange: (next: string[]) => void;
  label: string;
}) {
  const nameOf = (id: string) => providers.find((provider) => provider.id === id)?.name ?? id;
  const missing = (id: string) => !providers.some((provider) => provider.id === id);
  const rest = unlisted(providers, order);
  return (
    <div className="flex flex-col gap-2" aria-label={label}>
      {order.length === 0 ? (
        <p className="text-xs text-text-muted">
          No order set: providers are tried in the catalog&apos;s own order.
        </p>
      ) : (
        <ol className="divide-y divide-border rounded-md border border-border text-xs">
          {order.map((id, index) => (
            <li key={id} className="flex items-center gap-2 px-3 py-1.5">
              <span className="w-5 tabular-nums text-text-muted">{index + 1}</span>
              <span className="min-w-0 flex-1 truncate text-text-main">{nameOf(id)}</span>
              {missing(id) ? (
                <Badge size="sm" variant="warning">
                  No active connection
                </Badge>
              ) : null}
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Move ${nameOf(id)} up`}
                disabled={index === 0}
                onClick={() => onChange(moveItem(order, index, -1))}
              >
                <Icon icon={ArrowUp} size="sm" color="current" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Move ${nameOf(id)} down`}
                disabled={index === order.length - 1}
                onClick={() => onChange(moveItem(order, index, 1))}
              >
                <Icon icon={ArrowDown} size="sm" color="current" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Remove ${nameOf(id)} from the order`}
                onClick={() => onChange(removeItem(order, id))}
              >
                <Icon icon={X} size="sm" color="current" />
              </Button>
            </li>
          ))}
        </ol>
      )}
      {rest.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1 text-xs text-text-muted">
          <span>Add:</span>
          {rest.map((provider) => (
            <Button
              key={provider.id}
              variant="outline"
              size="sm"
              aria-label={`Add ${provider.name} to the order`}
              onClick={() => onChange(addItem(order, provider.id))}
            >
              <Icon icon={Plus} size="sm" color="current" />
              {provider.name}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  instance: "Instance",
  owner: "Pinned by you",
  tenant: "Tenant's choice",
};

export default function ModelVisibilityCard() {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [transparent, setTransparent] = useState(true);
  const [order, setOrder] = useState<string[]>([]);
  const [delegated, setDelegated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pinDraft, setPinDraft] = useState<
    Record<string, { mode: "inherit" | "on" | "off"; custom: boolean; order: string[] }>
  >({});

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/routing");
      const data = await res.json();
      if (!res.ok) throw new Error(errorText(data, "Could not load the routing policy."));
      setPolicy(data.policy);
      setProviders(data.providers ?? []);
      setTenants(data.tenants ?? []);
      setTransparent(data.policy.transparent);
      setOrder(data.policy.providerPriority ?? []);
      setDelegated(data.policy.delegated);
      setPinDraft({});
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : "Load failed." });
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const dirty =
    policy !== null &&
    (transparent !== policy.transparent ||
      delegated !== policy.delegated ||
      !sameOrder(order, policy.providerPriority));

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/routing", {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          transparent,
          providerPriority: order,
          delegateToTenants: delegated,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ ok: false, text: errorText(data, `The request failed (${res.status}).`) });
        return;
      }
      setMessage({ ok: true, text: "Saved." });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const draftFor = (tenant: TenantRow) =>
    pinDraft[tenant.id] ?? {
      mode:
        tenant.ownerPin.transparent === null
          ? "inherit"
          : tenant.ownerPin.transparent
            ? "on"
            : "off",
      custom: tenant.ownerPin.providerPriority !== null,
      order: tenant.ownerPin.providerPriority ?? tenant.effective.providerPriority,
    };

  const savePin = async (tenant: TenantRow) => {
    const draft = draftFor(tenant);
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/tenants/${tenant.id}/routing`, {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          transparent: draft.mode === "inherit" ? null : draft.mode === "on",
          priority: draft.custom ? draft.order : null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ ok: false, text: errorText(data, `The request failed (${res.status}).`) });
        return;
      }
      setMessage({ ok: true, text: `Saved for ${tenant.name}.` });
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (!policy) {
    return (
      <Card>
        <p className="text-sm text-text-muted">{message?.text ?? "Loading model visibility..."}</p>
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 rounded-lg bg-primary/10 text-primary">
          <Icon icon={Eye} size="lg" color="current" />
        </div>
        <div>
          <p className="font-medium">Model visibility</p>
          <p className="text-sm text-text-muted">
            Choose what clients see in the model list, and, when they do not pick the provider, the
            order RedRouter tries providers in.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <Toggle
          checked={transparent}
          onChange={setTransparent}
          label="Transparent model list"
          description="On: clients see provider/model and choose the provider. Off: clients see model names only, and RedRouter picks the provider by the order below. A provider prefix in a request is then ignored."
        />

        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-text-main">Provider priority</p>
          <p className="text-xs text-text-muted">
            {transparent
              ? "Not used while the model list is transparent, but it is kept."
              : "The first provider that offers a model is tried first; the next one takes over if it fails."}
          </p>
          <OrderEditor
            order={order}
            providers={providers}
            onChange={setOrder}
            label="Provider priority"
          />
        </div>

        <Toggle
          checked={delegated}
          onChange={setDelegated}
          label="Let tenant admins change this"
          description="When off, only you decide, for every tenant. When on, a tenant's admin can set its own mode and order, except for anything you pin for that tenant below. You always have the last word."
        />

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={save} disabled={!dirty || busy}>
            Save
          </Button>
          {message ? (
            <span
              role="status"
              className={`text-sm ${message.ok ? "text-feedback-success-foreground" : "text-feedback-danger-foreground"}`}
            >
              {message.text}
            </span>
          ) : null}
        </div>

        {tenants.length > 0 ? (
          <div className="flex flex-col gap-3 border-t border-border pt-4">
            <p className="text-sm font-medium text-text-main">Per tenant</p>
            <p className="text-xs text-text-muted">
              What you pin for a tenant always wins. Leave it on Inherit to use the instance policy
              {delegated ? " or the tenant admin's own choice." : "."}
            </p>
            {tenants.map((tenant) => {
              const draft = draftFor(tenant);
              const update = (patch: Partial<typeof draft>) =>
                setPinDraft({ ...pinDraft, [tenant.id]: { ...draft, ...patch } });
              return (
                <div
                  key={tenant.id}
                  className="flex flex-col gap-2 rounded-md border border-border p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-main">
                      {tenant.name}
                    </span>
                    <Badge size="sm" variant={tenant.effective.transparent ? "outline" : "primary"}>
                      {tenant.effective.transparent ? "Transparent" : "Model names only"}
                    </Badge>
                    <Badge size="sm" variant="outline">
                      {SOURCE_LABEL[tenant.effective.source.transparent] ?? "Instance"}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[14rem_1fr]">
                    <Select
                      label="Model list"
                      value={draft.mode}
                      onChange={(event) =>
                        update({ mode: event.target.value as "inherit" | "on" | "off" })
                      }
                      options={[
                        { value: "inherit", label: "Inherit" },
                        { value: "on", label: "Transparent" },
                        { value: "off", label: "Model names only" },
                      ]}
                    />
                    <Toggle
                      checked={draft.custom}
                      onChange={(checked) => update({ custom: checked })}
                      label="Pin a provider order for this tenant"
                    />
                  </div>
                  {draft.custom ? (
                    <OrderEditor
                      order={draft.order}
                      providers={providers}
                      onChange={(next) => update({ order: next })}
                      label={`Provider priority for ${tenant.name}`}
                    />
                  ) : null}
                  <div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => savePin(tenant)}
                      disabled={busy}
                    >
                      Save for {tenant.name}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </Card>
  );
}
