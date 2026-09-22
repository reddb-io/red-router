// What this gateway can do, for clients (e.g. redcode) that detect RedRouter and
// cooperate with it. Every value is read from the live configuration; each section
// fails open to its default so one unreadable source never hides the rest.

import { createHash } from "node:crypto";
import cliPkg from "../../cli/package.json" with { type: "json" };
import { getSettings, getProviderConnections, getApiKeyAllowedConnectionIds, getApiKeyOwner } from "@/lib/localDb";
import { resolveScopedSettings } from "@/lib/auth/scopedSettings";
import { DATA_DIR } from "@/lib/db/paths.js";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { normalizeDecisionConfig } from "@/sse/services/decisionRouter.js";
import { buildModelsList } from "@/app/api/v1/models/route.js";
import { SYSTEM_ONE_PROVIDER_IDS } from "open-sse/config/systemOne.js";
import { COMBO_STRATEGIES } from "open-sse/services/combo.js";
import { SESSION_HEADERS } from "open-sse/utils/sessionManager.js";
import { DECISION_HEADER, TOKEN_SAVER_HEADER } from "open-sse/config/runtimeConfig.js";

export const PRODUCT = "red-router";
export const SYSTEM_ONE_PATH = "/v1/systemone";

/**
 * Response headers this build sets on successful chat responses. Null until the
 * gateway emits them, so clients never wait on a header that will not come.
 */
export const RESPONSE_HEADERS = {
  servedModel: null,
  cost: null,
};

/** Build the GET /v1/capabilities document for the calling API key. */
export async function buildCapabilities({ apiKey = null } = {}) {
  const settings = await readSettings(apiKey);
  const decision = normalizeDecisionConfig(settings?.decisionRouter);
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
      accepts_hint: false,
    },
    session: {
      headers: [...SESSION_HEADERS],
      per_session_stickiness: false,
    },
    token_saver_header: TOKEN_SAVER_HEADER,
    served_model_header: RESPONSE_HEADERS.servedModel,
    cost_header: RESPONSE_HEADERS.cost,
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
