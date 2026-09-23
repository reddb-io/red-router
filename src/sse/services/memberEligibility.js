// Whether a combo member could be served right now, answered without touching
// the account-selection mutex or its side effects (round-robin counters, health
// exploration). Mirrors getProviderCredentials' filters: no-auth providers,
// active accounts, owner scope and per-user disabled accounts, the key's bound
// accounts, connection-prefix pinning, model locks, the Antigravity quota cache,
// and the key's model rules. A lock can expire between this check and the call;
// the combo's own fallback loop covers that.
import { getProviderConnections, getSettings, getApiKeyAllowedConnectionIds, getApiKeyOwner } from "@/lib/localDb";
import { resolveProviderId, FREE_PROVIDERS } from "@/shared/constants/providers.js";
import { isModelLockActive } from "open-sse/services/accountFallback.js";
import { stripThinkingSuffix } from "open-sse/translator/concerns/thinkingUnified.js";
import { getModelInfo } from "./model.js";
import { getAntigravityQuotaCache } from "./antigravityQuota.js";
import { checkModelAccess } from "@/lib/modelAccess";

export async function memberUsable(member, { apiKey = null, comboOwner = undefined, grantedByCombo = false } = {}) {
  try {
    const info = await getModelInfo(member, comboOwner);
    if (!info?.provider) return true; // a nested combo or unknown form: let routing decide
    const providerId = resolveProviderId(info.provider);
    const model = stripThinkingSuffix(info.model || "");
    if (await checkModelAccess({ apiKey, providerId, model, requested: member, grantedByCombo })) return false;
    if (FREE_PROVIDERS[providerId]?.noAuth) return true;

    let connections = await getProviderConnections({ provider: providerId, isActive: true });
    const settings = await getSettings();
    if (settings?.scopeResourcesByUser === true) {
      const owner = await getApiKeyOwner(apiKey || null);
      if (owner) {
        const { getDisabledAccountIds } = await import("@/lib/db/repos/disabledAccountsRepo.js");
        const disabled = new Set(await getDisabledAccountIds(owner));
        connections = connections.filter((c) => (!c.owner || c.owner === owner) && !disabled.has(c.id));
      } else {
        connections = connections.filter((c) => !c.owner);
      }
    }
    const allowed = await getApiKeyAllowedConnectionIds(apiKey || null);
    if (allowed) connections = connections.filter((c) => allowed.includes(c.id));
    if (Array.isArray(info.connectionIds)) connections = connections.filter((c) => info.connectionIds.includes(c.id));

    const quotaCache = providerId === "antigravity" && model ? getAntigravityQuotaCache() : null;
    const now = Date.now();
    return connections.some((c) => {
      if (isModelLockActive(c, model)) return false;
      const quota = quotaCache?.get(c.id)?.[model];
      return !(quota && quota.remainingPercentage <= 0 && quota.resetAt && new Date(quota.resetAt).getTime() > now);
    });
  } catch {
    return true; // eligibility is advice: on any doubt keep the member
  }
}

/** Splits members into those usable now and the rest, each in its original order. */
export async function partitionUsable(members, options = {}) {
  const flags = await Promise.all(members.map((m) => memberUsable(m, options)));
  return {
    usable: members.filter((_, i) => flags[i]),
    unusable: members.filter((_, i) => !flags[i]),
  };
}
