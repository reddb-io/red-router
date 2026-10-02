/**
 * The effective routing policy of a request: is the model list "transparent" (`provider/model`, the
 * client chooses the provider) and, when it is not, in which order the router tries providers.
 *
 * WHO WINS. The instance owner has the last word:
 *   1. what the owner pinned for the tenant (owner_* columns) — always;
 *   2. what the tenant's admin chose — only while the owner has delegated (`delegateRoutingToTenants`);
 *   3. the instance default set by the owner.
 * Mode and priority resolve independently, so an owner can pin the mode and still let tenants order
 * their providers.
 */

import { getSettings } from "@/lib/db/settings";
import { getTenantRoutingRow } from "@/lib/db/routingPolicy";
import { getRoutingProfile, getRoutingProfileBinding } from "@/lib/db/routingProfiles";

export type PolicySource = "instance" | "owner" | "tenant";
export interface ProfileOrigin {
  id: string;
  name: string;
}

export interface RoutingPolicy {
  /** true (default): `provider/model` ids, the client picks the provider. */
  transparent: boolean;
  /** Provider ids, first = tried first. Providers not listed follow, in the catalog's own order. */
  providerPriority: string[];
  source: { transparent: PolicySource; providerPriority: PolicySource };
  /** Whether tenant admins may currently override the instance policy. */
  delegated: boolean;
  profiles?: { transparent: ProfileOrigin | null; providerPriority: ProfileOrigin | null };
}

export const DEFAULT_TENANT_ID = "red";
const MAX_PROVIDERS = 300;

/** Unique, trimmed, non-empty provider ids in the order given. */
export function normalizeProviderPriority(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || id.length > 100 || seen.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase());
    out.push(id);
    if (out.length >= MAX_PROVIDERS) break;
  }
  return out;
}

export interface InstanceRoutingPolicy {
  transparent: boolean;
  providerPriority: string[];
  delegated: boolean;
  profileId: string | null;
  local: { transparent: boolean | null; providerPriority: string[] | null };
  defaults: { transparent: boolean; providerPriority: string[] };
  profiles: { transparent: ProfileOrigin | null; providerPriority: ProfileOrigin | null };
}

export async function getInstanceRoutingPolicy(): Promise<InstanceRoutingPolicy> {
  const settings = (await getSettings()) as Record<string, unknown>;
  const binding = getRoutingProfileBinding();
  const profile = binding ? getRoutingProfile(binding.profileId) : null;
  const origin = profile ? { id: profile.id, name: profile.name } : null;
  return {
    transparent:
      binding?.transparent ?? profile?.transparent ?? settings.transparentModels !== false,
    providerPriority: normalizeProviderPriority(
      binding?.providerPriority ?? profile?.providerPriority ?? settings.providerPriority
    ),
    delegated: settings.delegateRoutingToTenants === true,
    profileId: profile?.id ?? null,
    defaults: {
      transparent: settings.transparentModels !== false,
      providerPriority: normalizeProviderPriority(settings.providerPriority),
    },
    local: {
      transparent: profile ? binding!.transparent : settings.transparentModels !== false,
      providerPriority: profile
        ? binding!.providerPriority
        : normalizeProviderPriority(settings.providerPriority),
    },
    profiles: {
      transparent:
        profile && binding?.transparent === null && profile.transparent !== null ? origin : null,
      providerPriority:
        profile && binding?.providerPriority === null && profile.providerPriority !== null
          ? origin
          : null,
    },
  };
}

/**
 * The policy for a tenant. The default tenant (and a request with no tenant) follows the instance
 * policy, plus anything the owner pinned for it.
 */
export async function resolveRoutingPolicy(tenantId?: string | null): Promise<RoutingPolicy> {
  const instance = await getInstanceRoutingPolicy();
  const policy: RoutingPolicy = {
    transparent: instance.transparent,
    providerPriority: instance.providerPriority,
    source: { transparent: "instance", providerPriority: "instance" },
    delegated: instance.delegated,
    profiles: { ...instance.profiles },
  };
  if (!tenantId) return policy;

  const row = getTenantRoutingRow(tenantId);
  const binding = getRoutingProfileBinding(tenantId);
  const profile = binding ? getRoutingProfile(binding.profileId) : null;
  const origin = profile ? { id: profile.id, name: profile.name } : null;
  const ownerTransparent = row?.ownerTransparent ?? profile?.transparent ?? null;
  const ownerPriority = row?.ownerPriority ?? profile?.providerPriority ?? null;

  // Mode
  if (ownerTransparent !== null) {
    policy.transparent = ownerTransparent;
    policy.source.transparent = "owner";
    policy.profiles.transparent = row?.ownerTransparent != null ? null : origin;
  } else if (instance.delegated && row?.tenantTransparent != null) {
    policy.transparent = row.tenantTransparent;
    policy.source.transparent = "tenant";
    policy.profiles.transparent = null;
  }

  // Priority
  if (ownerPriority !== null) {
    policy.providerPriority = normalizeProviderPriority(ownerPriority);
    policy.source.providerPriority = "owner";
    policy.profiles.providerPriority = row?.ownerPriority != null ? null : origin;
  } else if (instance.delegated && row?.tenantPriority != null) {
    policy.providerPriority = normalizeProviderPriority(row.tenantPriority);
    policy.source.providerPriority = "tenant";
    policy.profiles.providerPriority = null;
  }
  return policy;
}
