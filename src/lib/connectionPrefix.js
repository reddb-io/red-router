// Connection model prefixes: a name the user gives accounts of a built-in provider so
// "<prefix>/<model>" routes to those accounts only ("codex-work/…", "codex-home/…" for
// two Codex accounts) and /v1/models lists the provider's models under it.
import { getCombos, getProviderConnections, getProviderNodes } from "@/lib/localDb";
import { connectionModelPrefix, providerIdentity } from "open-sse/providers/identity.js";
import { builtInProviderForToken } from "@/sse/services/model.js";

export const MODEL_PREFIX_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
export const MODEL_PREFIX_MAX_LENGTH = 64;

/**
 * Check the model prefix one connection of a built-in provider asks for. Connections
 * of the same provider may share a prefix (they then route as one pool); every other
 * owner of a prefix token — a built-in provider, another provider's connection, a
 * custom node, a combo — makes it unavailable.
 * @param {object} input - { prefix, providerId, connectionId }
 * @returns {Promise<{ prefix: string } | { error: string }>} "" clears the prefix
 */
export async function validateConnectionPrefix({ prefix, providerId, connectionId = null }) {
  const value = typeof prefix === "string" ? prefix.trim() : "";
  if (!value) return { prefix: "" };
  const formatError = prefixFormatError(value);
  if (formatError) return { error: formatError };

  const owner = builtInProviderForToken(value);
  if (owner === providerId) {
    return { error: `"${value}" is already ${providerName(providerId)}'s own prefix. Leave the field empty to use it.` };
  }
  if (owner) return { error: `"${value}" is the built-in prefix of ${providerName(owner)}. Choose another name.` };

  const [connections, nodes, combos] = await Promise.all([
    getProviderConnections(),
    getProviderNodes(),
    getCombos(),
  ]);
  const node = (nodes || []).find((n) => n.prefix === value);
  if (node) return { error: `"${value}" is the prefix of the custom provider "${node.name || node.id}". Choose another name.` };

  const other = (connections || []).find((c) => c.id !== connectionId && c.provider !== providerId && connectionModelPrefix(c) === value);
  if (other) {
    return { error: `"${value}" is already the model prefix of the ${providerName(other.provider)} connection "${connectionLabel(other)}". Choose another name.` };
  }

  if ((combos || []).some((c) => c.name === value)) {
    return { error: `"${value}" is the name of a combo. Choose another name.` };
  }
  return { prefix: value };
}

/** The built-in-provider connection that already uses a prefix, or null (custom nodes check this). */
export async function connectionUsingPrefix(prefix) {
  const value = typeof prefix === "string" ? prefix.trim() : "";
  if (!value) return null;
  return ((await getProviderConnections()) || []).find((c) => connectionModelPrefix(c) === value) || null;
}

/** The label a connection shows in the dashboard and in /v1/models `provider.connection.name`. */
export function connectionLabel(connection) {
  return connection?.name?.trim() || connection?.displayName?.trim() || connection?.email?.trim() || connection?.id || "";
}

function prefixFormatError(value) {
  if (value.length > MODEL_PREFIX_MAX_LENGTH) return `A model prefix is at most ${MODEL_PREFIX_MAX_LENGTH} characters.`;
  if (!MODEL_PREFIX_PATTERN.test(value)) {
    return `"${value}" is not a valid model prefix: use lowercase letters, digits, ".", "_" and "-", starting with a letter or digit.`;
  }
  return null;
}

function providerName(providerId) {
  return providerIdentity(providerId)?.name || providerId;
}
