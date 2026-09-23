// Capability overrides: the dashboard's corrections to what RedRouter believes a
// model can do (a vision flag, a context window, whether thinking can be turned
// off). Stored in the kv table, held in memory, and applied by
// getCapabilitiesForModel — so routing, /v1/models and `parameters` all see them.
import { getCapabilityOverrides, setCapabilityOverride } from "@/lib/db/index.js";
import { setCapabilityOverrideSource } from "open-sse/providers/capabilities.js";
import { resolveProviderAlias } from "open-sse/services/model.js";

const BOOLEAN_KEYS = [
  "vision", "pdf", "audioInput", "videoInput", "imageOutput", "audioOutput",
  "search", "tools", "reasoning", "thinkingCanDisable", "thinkingEffortSupported", "forcedToolChoice",
];
const TOKEN_KEYS = ["contextWindow", "maxOutput"];
const THINKING_FORMATS = new Set([
  "openai", "claude-adaptive", "claude-budget", "gemini-level", "gemini-budget",
  "zai", "qwen", "deepseek", "kimi", "minimax", "hunyuan", "step",
]);

/** Only known keys with valid values; null when nothing is left. */
export function normalizeCapabilityOverride(value) {
  if (!value || typeof value !== "object") return null;
  const out = {};
  for (const key of BOOLEAN_KEYS) if (typeof value[key] === "boolean") out[key] = value[key];
  for (const key of TOKEN_KEYS) {
    const n = Number(value[key]);
    if (value[key] !== null && value[key] !== "" && Number.isInteger(n) && n > 0) out[key] = n;
  }
  if (typeof value.thinkingFormat === "string" && THINKING_FORMATS.has(value.thinkingFormat)) out.thinkingFormat = value.thinkingFormat;
  return Object.keys(out).length ? out : null;
}

/** "<providerId>/<model>" for a provider token (id, alias or slug), or "*\/<model>". */
export function overrideKey(provider, model) {
  const id = !provider || provider === "*" ? "*" : resolveProviderAlias(provider);
  return `${id}/${model}`;
}

let overrides = {};

function lookup(provider, model) {
  if (!model) return null;
  const base = model.includes("/") ? model.split("/").pop() : model;
  const id = provider ? resolveProviderAlias(provider) : null;
  const any = overrides[`*/${model}`] || overrides[`*/${base}`];
  const own = id ? overrides[`${id}/${model}`] || overrides[`${id}/${base}`] : null;
  if (!any && !own) return null;
  return { ...(any || {}), ...(own || {}) };
}

/** Read the stored overrides and install the lookup. Called at startup and after a change. */
export async function loadCapabilityOverrides() {
  try {
    overrides = await getCapabilityOverrides();
  } catch {
    overrides = {};
  }
  setCapabilityOverrideSource(Object.keys(overrides).length ? lookup : null);
  return overrides;
}

export async function saveCapabilityOverride(provider, model, caps) {
  const normalized = normalizeCapabilityOverride(caps);
  await setCapabilityOverride(overrideKey(provider, model), normalized);
  await loadCapabilityOverrides();
  return normalized;
}
