import { getDb } from "../kysely.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { DEFAULT_AUTOPILOT } from "open-sse/decision/reasoningAutopilot.js";

const DEFAULT_MITM_ROUTER_BASE = "http://localhost:25050";
const DEFAULT_HEADROOM_URL = process.env.HEADROOM_URL || "http://localhost:8787";

const DEFAULT_SETTINGS = {
  cloudEnabled: false,
  tunnelEnabled: false,
  tunnelUrl: "",
  tunnelProvider: "cloudflare",
  tailscaleEnabled: false,
  tailscaleUrl: "",
  stickyRoundRobinLimit: 3,
  providerStrategies: {},
  quotaVisibility: {},
  comboStrategy: "fallback",
  comboStickyRoundRobinLimit: 1,
  comboStrategies: {},
  capacityAdapter: {
    vision: { enabled: true, roundRobin: false, models: [] },
    pdf: { enabled: false, roundRobin: false, models: [] },
    audioInput: { enabled: true, roundRobin: false, models: [] },
    videoInput: { enabled: false, roundRobin: false, models: [] },
  },
  requireLogin: true,
  requireApiKey: true,
  tunnelDashboardAccess: true,
  authMode: "password",
  ssoType: "oidc",
  // Off: every resource stays visible to anyone who can log in (legacy behaviour).
  // Turning it off later never drops ownership, it only stops enforcing it.
  scopeResourcesByUser: false,
  // E-mails that act as admin when password login is unavailable (SSO-only).
  ssoAdminEmails: [],
  oidcIssuerUrl: "",
  oidcClientId: "",
  oidcClientSecret: "",
  oidcScopes: "openid profile email",
  oidcLoginLabel: "Sign in with OIDC",
  samlEntryPoint: "",
  samlIssuer: "urn:red-router:sp",
  samlCert: "",
  samlLoginLabel: "Sign in with SAML SSO",
  samlAttributeEmail: "email",
  samlAttributeName: "name",
  enableObservability: false,
  observabilityMaxRecords: 1000,
  observabilityBatchSize: 20,
  observabilityFlushIntervalMs: 5000,
  observabilityMaxJsonSize: 5,
  outboundProxyEnabled: false,
  outboundProxyUrl: "",
  outboundNoProxy: "",
  mitmRouterBaseUrl: DEFAULT_MITM_ROUTER_BASE,
  dnsToolEnabled: {},
  rtkEnabled: true,
  headroomEnabled: false,
  headroomUrl: DEFAULT_HEADROOM_URL,
  headroomCompressUserMessages: false,
  // Route each API key's traffic to its own Headroom project (/p/<key name>),
  // so per-project stats separate the callers instead of pooling them.
  headroomPerApiKeyProject: false,
  // Per-user token-saver overrides, keyed by owner. A key left unset here keeps
  // the global (admin) value, so the default lives in one place.
  tokenSaverByOwner: {},
  headroomTimeoutMs: 3000,
  cavemanEnabled: false,
  cavemanLevel: "full",
  ponytailEnabled: false,
  ponytailLevel: "full",
  adhdEnabled: false,
  adhdLevel: "full",
  pxpipeEnabled: false,
  pxpipeAutoInstall: true,
  pxpipeMinChars: 25000,
  pxpipeTimeoutMs: 15000,
  decisionRouter: {
    mode: "off",
    provider: "vercel-ai-gateway",
    model: "typesafe-ai/jev",
    models: [],
    effort: false,
    toolMode: "hint",
    minStrength: 0.35,
    switchStrength: 0.6,
    minConfidence: 0.7,
    timeoutMs: 1500,
  },
  reasoningAutopilot: { ...DEFAULT_AUTOPILOT },
  // /v1/models listing. prefixStyle "slug" lists readable ids ("claude-code/<model>");
  // "short" keeps the legacy short codes ("cc/<model>"). Both always route. variants
  // "collapse" folds level/mode variant ids into their base entry; "expand" lists each.
  catalog: { prefixStyle: "slug", variants: "collapse" },
};

async function readRaw() {
  const db = await getDb();
  const row = await db.selectFrom("settings").select("data").where("id", "=", 1).executeTakeFirst();
  return row ? parseJson(row.data, {}) : {};
}

// Merge raw settings with defaults; backward-compat for missing keys
export function mergeWithDefaults(raw) {
  const merged = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  if (merged.decisionRouter && typeof merged.decisionRouter === "object" && !Array.isArray(merged.decisionRouter)) {
    merged.decisionRouter = { ...DEFAULT_SETTINGS.decisionRouter, ...merged.decisionRouter };
  }
  if (merged.reasoningAutopilot && typeof merged.reasoningAutopilot === "object" && !Array.isArray(merged.reasoningAutopilot)) {
    merged.reasoningAutopilot = { ...DEFAULT_SETTINGS.reasoningAutopilot, ...merged.reasoningAutopilot };
  }
  if (merged.catalog && typeof merged.catalog === "object" && !Array.isArray(merged.catalog)) {
    merged.catalog = { ...DEFAULT_SETTINGS.catalog, ...merged.catalog };
  }
  for (const [key, defVal] of Object.entries(DEFAULT_SETTINGS)) {
    if (merged[key] === undefined) {
      if (
        key === "outboundProxyEnabled" &&
        typeof merged.outboundProxyUrl === "string" &&
        merged.outboundProxyUrl.trim()
      ) {
        merged[key] = true;
      } else {
        merged[key] = defVal;
      }
    }
  }
  return merged;
}

export async function getSettings() {
  const raw = await readRaw();
  return mergeWithDefaults(raw);
}

// Atomic read-merge-write inside transaction (prevents losing concurrent updates)
export async function updateSettings(updates) {
  const db = await getDb();
  let next;
  await db.transaction().execute(async (trx) => {
    const row = await trx.selectFrom("settings").select("data").where("id", "=", 1).executeTakeFirst();
    const current = row ? parseJson(row.data, {}) : {};
    next = { ...current, ...updates };
    const data = stringifyJson(next);
    await trx.insertInto("settings")
      .values({ id: 1, data })
      .onConflict((oc) => oc.column("id").doUpdateSet({ data }))
      .execute();
  });
  return mergeWithDefaults(next);
}

export async function isCloudEnabled() {
  const settings = await getSettings();
  return settings.cloudEnabled === true;
}

export async function getCloudUrl() {
  const settings = await getSettings();
  return (
    settings.cloudUrl ||
    process.env.CLOUD_URL ||
    process.env.NEXT_PUBLIC_CLOUD_URL ||
    ""
  );
}

export async function exportSettings() {
  return await readRaw();
}
