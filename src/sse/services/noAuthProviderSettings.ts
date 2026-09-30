import { getSettings } from "@/lib/db/settings";
import { isProviderBlockedByIdOrAlias } from "@/shared/utils/noAuthProviders";
import { isProviderEnabledNow } from "@/lib/providers/enabledProvidersAccessor";
import * as log from "../utils/logger";

export async function isNoAuthProviderBlockedBySettings(providerId: string): Promise<boolean> {
  try {
    const settings = await getSettings();
    return isProviderBlockedByIdOrAlias(providerId, settings.blockedProviders);
  } catch (error) {
    log.warn(
      "AUTH",
      `Could not read blocked provider settings for ${providerId}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return false;
  }
}

/**
 * Per-provider opt-out for the synthetic anonymous (no-auth) credential
 * fallback. Only applies to API-key gateway providers whose fallback
 * eligibility comes from `anonymousFallback: true` on the static provider
 * definition (e.g. opencode-go, opencode-zen). True no-auth providers
 * (NOAUTH_PROVIDERS / WEB_COOKIE_PROVIDERS) are NOT matched here — for them
 * the synthetic credential is the only credential path, and `blockedProviders`
 * remains the disable mechanism.
 *
 * Fail-open: any settings-read error returns false, preserving current
 * behavior (anonymous fallback keeps working).
 */
export async function isAnonymousFallbackDisabledBySettings(providerId: string): Promise<boolean> {
  try {
    const settings = await getSettings();
    return isProviderBlockedByIdOrAlias(providerId, settings.noAuthFallbackDisabledProviders);
  } catch (error) {
    log.warn(
      "AUTH",
      `Could not read no-auth fallback disabled settings for ${providerId}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return false;
  }
}

/**
 * RedRouter is opt-in: the synthetic anonymous credential is only handed out
 * when the operator enabled the provider (`enabledNoAuthProviders`) or the
 * provider has an active connection. Fail-closed: if enablement cannot be read,
 * nothing anonymous is served.
 */
export async function isSyntheticNoAuthAllowed(providerId: string): Promise<boolean> {
  try {
    return await isProviderEnabledNow(providerId);
  } catch (error) {
    log.warn(
      "AUTH",
      `Could not read provider enablement for ${providerId}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return false;
  }
}
