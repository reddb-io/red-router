"use client";

// Model visibility: whether clients see `provider/model` (transparent, the default) or bare model
// names, in which case the router picks the provider from the order set here. The owner has the last
// word: a tenant's own choice counts only while it is delegated, and never over what is pinned below.

import { Eye } from "lucide-react";
import RoutingPreview from "@/shared/components/routing/RoutingPreview";
import Icon from "@/shared/components/Icon";
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, Select, Toggle } from "@/shared/components";
import { sameOrder, type ProviderOption } from "./providerPriorityList";

import OrderEditor from "./ProviderOrderEditor";
import RoutingProfilesEditor, { type Profile } from "./RoutingProfilesEditor";

interface Policy {
  transparent: boolean;
  providerPriority: string[];
  delegated: boolean;
  profileId: string | null;
  local: { transparent: boolean | null; providerPriority: string[] | null };
  defaults: { transparent: boolean; providerPriority: string[] };
}

interface TenantRow {
  id: string;
  slug: string;
  name: string;
  isDefault: boolean;
  ownerPin: {
    transparent: boolean | null;
    providerPriority: string[] | null;
    profileId: string | null;
  };
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

const SOURCE_LABEL: Record<string, string> = {
  instance: "Instance",
  owner: "Pinned by you",
  tenant: "Tenant's choice",
};

export default function ModelVisibilityCard() {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [visibility, setVisibility] = useState<"inherit" | "on" | "off">("on");
  const [profileId, setProfileId] = useState("");
  const [customOrder, setCustomOrder] = useState(true);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [order, setOrder] = useState<string[]>([]);
  const [delegated, setDelegated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editingProfile, setEditingProfile] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pinDraft, setPinDraft] = useState<
    Record<
      string,
      { mode: "inherit" | "on" | "off"; custom: boolean; order: string[]; profileId: string }
    >
  >({});

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/routing");
      const data = await res.json();
      if (!res.ok) throw new Error(errorText(data, "Could not load the routing policy."));
      setPolicy(data.policy);
      setProviders(data.providers ?? []);
      setTenants(data.tenants ?? []);
      setProfiles(data.profiles ?? []);
      setProfileId(data.policy.profileId ?? "");
      setVisibility(
        data.policy.local.transparent === null
          ? "inherit"
          : data.policy.local.transparent
            ? "on"
            : "off"
      );
      setCustomOrder(data.policy.local.providerPriority !== null);
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

  const selectedProfile = profiles.find((entry) => entry.id === profileId);
  const transparent =
    visibility === "inherit"
      ? (selectedProfile?.transparent ?? policy?.defaults.transparent ?? true)
      : visibility === "on";
  const priorityValue = customOrder
    ? order
    : (selectedProfile?.providerPriority ?? policy?.defaults.providerPriority ?? []);
  const dirty =
    policy !== null &&
    (profileId !== (policy.profileId ?? "") ||
      (visibility === "inherit" ? null : transparent) !== policy.local.transparent ||
      customOrder !== (policy.local.providerPriority !== null) ||
      delegated !== policy.delegated ||
      (customOrder && !sameOrder(order, policy.local.providerPriority ?? [])));

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/routing", {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          profileId: profileId || null,
          transparent: profileId && visibility === "inherit" ? null : transparent,
          providerPriority: profileId && !customOrder ? null : priorityValue,
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
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : "Save failed." });
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
      profileId: tenant.ownerPin.profileId ?? "",
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
          profileId: draft.profileId || null,
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
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : "Save failed." });
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

      <fieldset disabled={busy} className="flex flex-col gap-4">
        <RoutingProfilesEditor
          profiles={profiles}
          providers={providers}
          onChanged={load}
          disabled={dirty || Object.keys(pinDraft).length > 0}
          onBusyChange={setBusy}
          onEditingChange={setEditingProfile}
        />
        <fieldset disabled={editingProfile} className="flex flex-col gap-4">
          <Select
            label="Instance routing profile"
            placeholder=""
            value={profileId}
            onChange={(event) => {
              const id = event.target.value;
              setProfileId(id);
              setVisibility(id ? "inherit" : policy.defaults.transparent ? "on" : "off");
              setCustomOrder(!id);
              setOrder(
                id
                  ? (profiles.find((entry) => entry.id === id)?.providerPriority ??
                      policy.defaults.providerPriority)
                  : policy.defaults.providerPriority
              );
            }}
            options={[
              { value: "", label: "No profile (stored instance defaults)" },
              ...profiles.map((profile) => ({ value: profile.id, label: profile.name })),
            ]}
          />
          <Select
            label="Model visibility"
            value={visibility}
            onChange={(event) => setVisibility(event.target.value as "inherit" | "on" | "off")}
            options={[
              ...(profileId
                ? [{ value: "inherit", label: "Follow profile (or stored default)" }]
                : []),
              { value: "on", label: "Provider prefixes visible" },
              { value: "off", label: "Provider prefixes hidden" },
            ]}
          />
          <p className="text-xs text-text-muted">
            With prefixes hidden, RedRouter chooses providers for the same model family.
            Manufacturer namespaces remain distinct. Local choices override the attached profile.
            Detaching restores stored instance defaults.
          </p>
          {profileId && (
            <Toggle
              checked={customOrder}
              onChange={(checked) => {
                setCustomOrder(checked);
                setOrder(priorityValue);
              }}
              label="Override profile provider priority"
            />
          )}
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium text-text-main">Provider priority</p>
            <p className="text-xs text-text-muted">
              {transparent
                ? "Used when provider prefixes are hidden."
                : "Unlisted providers follow in catalog order. Access restrictions still apply."}
            </p>
            {customOrder ? (
              <OrderEditor
                order={order}
                providers={providers}
                onChange={setOrder}
                label="Provider priority"
              />
            ) : (
              <p className="text-sm">{priorityValue.join(" → ") || "Catalog order"}</p>
            )}
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
                What you pin for a tenant always wins. Leave it on Inherit to use the instance
                policy
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
                      <Badge
                        size="sm"
                        variant={tenant.effective.transparent ? "outline" : "primary"}
                      >
                        {tenant.effective.transparent ? "Transparent" : "Model names only"}
                      </Badge>
                      <Badge size="sm" variant="outline">
                        {SOURCE_LABEL[tenant.effective.source.transparent] ?? "Instance"}
                      </Badge>
                    </div>
                    <Select
                      label={`Owner routing profile for ${tenant.name}`}
                      placeholder=""
                      value={draft.profileId}
                      onChange={(event) => update({ profileId: event.target.value })}
                      options={[
                        { value: "", label: "No owner profile" },
                        ...profiles.map((profile) => ({ value: profile.id, label: profile.name })),
                      ]}
                    />
                    <p className="text-xs text-text-muted">
                      Local pins override the profile. Inherit follows its defined fields, then the
                      delegated tenant choice or instance defaults.
                    </p>
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
        </fieldset>
      </fieldset>
      <RoutingPreview />
    </Card>
  );
}
