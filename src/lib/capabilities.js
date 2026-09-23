// What this gateway can do, for clients (e.g. redcode) that detect RedRouter and
// cooperate with it. Every value is read from the live configuration; each section
// fails open to its default so one unreadable source never hides the rest.

import { createHash } from "node:crypto";
import cliPkg from "../../cli/package.json" with { type: "json" };
import { getSettings, getProviderConnections, getApiKeyAllowedConnectionIds, getApiKeyOwner } from "@/lib/localDb";
import { resolveScopedSettings } from "@/lib/auth/scopedSettings";
import { getCatalogVersion } from "@/lib/catalogVersion";
import { DATA_DIR } from "@/lib/db/paths.js";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { normalizeDecisionConfig } from "@/sse/services/decisionRouter.js";
import { buildModelsList } from "@/app/api/v1/models/route.js";
import { SYSTEM_ONE_PROVIDER_IDS } from "open-sse/config/systemOne.js";
import { COMBO_STRATEGIES } from "open-sse/services/combo.js";
import { SESSION_HEADERS, AFFINITY_HEADERS } from "open-sse/utils/sessionManager.js";
import { COST_HEADER, DECISION_HEADER, HINT_HEADER, REASONING_HEADER, REASONING_RESPONSE_HEADER, REQUEST_ID_HEADER, SERVED_MODEL_HEADER, SESSION_AFFINITY_CONFIG, TOKEN_SAVER_HEADER, CATALOG_VERSION_HEADER } from "open-sse/config/runtimeConfig.js";
import { HINT_KEYS } from "open-sse/decision/clientHint.js";
import { normalizeAutopilotConfig } from "open-sse/decision/reasoningAutopilot.js";

export const PRODUCT = "red-router";
export const SYSTEM_ONE_PATH = "/v1/systemone";

/**
 * Response headers this build sets on successful chat responses. The cost header
 * is only present when the cost is known before the body is sent (non-streaming);
 * streams carry it as `usage.cost` in their final usage event instead.
 */
export const RESPONSE_HEADERS = {
  servedModel: SERVED_MODEL_HEADER,
  cost: COST_HEADER,
  requestId: REQUEST_ID_HEADER,
};

/** Build the GET /v1/capabilities document for the calling API key. */
export async function buildCapabilities({ apiKey = null } = {}) {
  const settings = await readSettings(apiKey);
  const decision = normalizeDecisionConfig(settings?.decisionRouter);
  const reasoning = normalizeAutopilotConfig(settings?.reasoningAutopilot);
  return {
    product: PRODUCT,
    version: cliPkg.version,
    instance_id: await instanceId(),
    systemone: await systemOneCapabilities(apiKey),
    combos: { strategies: [...COMBO_STRATEGIES] },
    decision: {
      mode: decision.mode,
      tool_mode: decision.toolMode,
      effort: decision.effort === true,
      header: DECISION_HEADER,
      accepts_hint: true,
      hint_header: HINT_HEADER,
      hint_keys: [...HINT_KEYS],
      // `off` plus a hint still lets an auto combo pick its member from the hint.
      off_keeps_hinted_model: true,
    },
    reasoning: {
      mode: reasoning.mode,
      header: REASONING_HEADER,
      response_header: REASONING_RESPONSE_HEADER,
    },
    session: {
      headers: [...SESSION_HEADERS],
      // Combo member stickiness is keyed on these headers only (parent first).
      per_session_stickiness: true,
      affinity_headers: [...AFFINITY_HEADERS],
      affinity_ttl_ms: SESSION_AFFINITY_CONFIG.ttlMs,
      prompt_cache_key: true,
    },
    token_saver_header: TOKEN_SAVER_HEADER,
    served_model_header: RESPONSE_HEADERS.servedModel,
    cost_header: RESPONSE_HEADERS.cost,
    request_id_header: RESPONSE_HEADERS.requestId,
    stream_usage_cost: true,
    // /v1/models entries carry `parameters` (combos: `members` too); a response's
    // version header tells a client when its cached catalog is out of date.
    catalog: {
      version: await getCatalogVersion(apiKey),
      version_header: CATALOG_VERSION_HEADER,
      model_endpoint: "/v1/models/{id}",
      model_parameters: true,
      combo_members: true,
    },
  };
}

async function readSettings(apiKey) {
  try {
    return await resolveScopedSettings(await getSettings(), apiKey);
  } catch {
    return null;
  }
}

/**
 * RED_ROUTER_INSTANCE_ID when set; otherwise derived from the machine id and the
 * data directory, so it survives restarts and two instances on one host differ.
 */
export async function instanceId() {
  const configured = process.env.RED_ROUTER_INSTANCE_ID?.trim();
  if (configured) return configured;
  try {
    const machine = await getConsistentMachineId("red-router-instance");
    return `rr_${createHash("sha256").update(`${machine}:${DATA_DIR}`).digest("hex").slice(0, 16)}`;
  } catch {
    return `rr_${createHash("sha256").update(DATA_DIR).digest("hex").slice(0, 16)}`;
  }
}

/**
 * Available only when the key can reach an active account of a System One
 * provider; the model list is then the same one /v1/models/systemone serves.
 */
async function systemOneCapabilities(apiKey) {
  const unavailable = { endpoint: SYSTEM_ONE_PATH, available: false, models: [] };
  try {
    if (!(await hasSystemOneAccount(apiKey))) return unavailable;
    const models = await buildModelsList(["systemone"], { apiKey });
    const ids = models.map((model) => model.id).filter(Boolean);
    return { endpoint: SYSTEM_ONE_PATH, available: ids.length > 0, models: ids };
  } catch {
    return unavailable;
  }
}

async function hasSystemOneAccount(apiKey) {
  const connections = (await getProviderConnections())
    .filter((c) => c.isActive !== false && SYSTEM_ONE_PROVIDER_IDS.includes(c.provider));
  const allowed = await getApiKeyAllowedConnectionIds(apiKey || null);
  // Same ownership rule as the /v1/models catalogue.
  const scoped = (await getSettings())?.scopeResourcesByUser === true;
  const owner = scoped ? await getApiKeyOwner(apiKey || null) : null;
  return connections.some((c) => (!allowed || allowed.includes(c.id)) && (!scoped || !c.owner || c.owner === owner));
}
