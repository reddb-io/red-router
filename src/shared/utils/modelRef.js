// Model references as people see and save them: "<slug>/<model>" ("codex/gpt-5.5",
// "opencode-go/glm-5.3-flash"), the form /v1/models lists. Every provider token still
// routes (legacy short codes like "cx/" included), so a reference saved in any form
// keeps working; these helpers only decide what the dashboard shows and writes, and
// let it recognise two spellings of the same model as one.
import { PROVIDER_TOKEN_TO_ID, providerSlug } from "open-sse/providers/identity.js";

/** The built-in provider a token names ("cx", "codex", "openai"...), or null. */
export function providerIdOfToken(token) {
  return (token && PROVIDER_TOKEN_TO_ID.get(token)) || null;
}

/** "<slug>/<model>" for a built-in provider id and a model id. */
export function publicModelId(providerId, modelId) {
  return `${providerSlug(providerId)}/${modelId}`;
}

/**
 * The readable spelling of a saved reference: "cx/gpt-5.5" -> "codex/gpt-5.5".
 * Combo names, custom-node prefixes, per-connection prefixes and anything else that
 * is not a built-in provider token come back unchanged.
 */
export function publicModelRef(ref) {
  if (typeof ref !== "string") return ref;
  const slash = ref.indexOf("/");
  if (slash <= 0) return ref;
  const providerId = providerIdOfToken(ref.slice(0, slash));
  return providerId ? publicModelId(providerId, ref.slice(slash + 1)) : ref;
}

/** True when two references name the same model ("cx/gpt-5.5" and "codex/gpt-5.5"). */
export function sameModelRef(a, b) {
  if (a === b) return true;
  if (typeof a !== "string" || typeof b !== "string") return false;
  return publicModelRef(a) === publicModelRef(b);
}
