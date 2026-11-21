export interface RustAuthConfig {
  backend: "rust";
  control_plane_enabled: boolean;
  oidc_browser_login: boolean;
  password_login: boolean;
}

export interface RustRuntimeStatus {
  live: boolean;
  ready: boolean;
  checked_at: string;
}

export interface RustClientAccessSchedule {
  enabled: boolean;
  from: string;
  until: string;
  days: number[];
  tz: string;
}

export interface RustClientKey {
  model_matching?: "native" | "legacy-v1";
  id: string;
  label: string;
  tenant_id: string;
  created_by: string;
  model_id_format: "prefixed" | "flat";
  model_access_mode: "all" | "restricted";
  allowed_combos: string[] | null;
  enabled: boolean;
  expires_at_unix: number | null;
  access_schedule: RustClientAccessSchedule | null;
  scopes: string[];
  allowed_endpoints: string[];
  allowed_models: string[];
  blocked_models: string[];
  allowed_provider_ids: string[];
  max_concurrent_requests: number | null;
  max_requests_per_minute: number | null;
  max_requests_per_day: number | null;
  max_tokens_per_minute: number | null;
  max_tokens_per_day: number | null;
  max_spend_per_month_usd: number | null;
  reservation_tokens: number | null;
  reservation_spend_usd: number | null;
  revision: string;
}

export type RustClientKeyInput = Omit<
  RustClientKey,
  "id" | "tenant_id" | "created_by" | "revision" | "expires_at_unix" | "model_matching"
> & {
  tenant_id?: string;
  expires_at_unix?: number | null;
};

export interface RustIssuedClientKey {
  client_key: RustClientKey;
  key: string;
  warning: string;
}

export type RustSharedBudgetDuration = "daily" | "monthly" | "total";

export interface RustSharedBudget {
  id: string;
  tenant_id: string;
  name: string;
  max_spend_usd: number;
  reservation_spend_usd: number;
  duration: RustSharedBudgetDuration;
  enabled: boolean;
  key_ids: string[];
  tags: string[];
  users: string[];
  spent_usd: number;
  reserved_usd: number;
  window_start_unix_ms: number;
  reset_at_unix_ms: number | null;
  revision: string;
}

export interface RustSharedBudgetInput {
  tenant_id?: string;
  name: string;
  max_spend_usd: number;
  reservation_spend_usd: number;
  duration: RustSharedBudgetDuration;
  enabled: boolean;
  key_ids: string[];
  tags: string[];
  users: string[];
}

export interface RustTenant {
  id: string;
  slug: string;
  name: string;
  enabled: boolean;
  revision: string;
}

export interface RustTenantInput {
  slug: string;
  name: string;
  enabled: boolean;
}

export type RustIdentityRole = "admin" | "tenant-admin" | "issuer";

export interface RustIdentityBinding {
  id: string;
  subject: string;
  tenant_id: string;
  role: RustIdentityRole;
  enabled: boolean;
  revision: string;
}

export interface RustIdentityBindingInput {
  subject?: string;
  oidc_issuer?: string;
  oidc_subject?: string;
  tenant_id: string;
  role: RustIdentityRole;
  enabled: boolean;
}

export interface RustAuditEvent {
  id: string;
  timestamp: string;
  createdAt: string;
  action: string;
  actor: string;
  tenantId: string;
  target: string;
  resourceType: string;
  status: string;
  requestId: string;
  details: unknown;
  metadata: unknown;
  ip: string | null;
  ipAddress: string | null;
}

export interface RustAuditQuery {
  action?: string;
  actor?: string;
  target?: string;
  resourceType?: string;
  status?: string;
  requestId?: string;
  limit?: number;
  offset?: number;
}

export interface RustAuditPage {
  events: RustAuditEvent[];
  total: number;
}

export type RustTokenLimitInterval = "daily" | "weekly" | "monthly";

export interface RustTokenLimit {
  id: string;
  apiKeyId: string;
  scopeType: "model";
  scopeValue: string;
  tokenLimit: number;
  resetInterval: RustTokenLimitInterval;
  resetTime: string;
  enabled: true;
  tokensUsed: number;
  windowStart: string;
  periodStartAt: number;
  nextResetAt: number;
  remaining: number;
}

export interface RustTokenLimitInput {
  id?: string;
  apiKeyId: string;
  scopeType: "model";
  scopeValue: string;
  tokenLimit: number;
  resetInterval: RustTokenLimitInterval;
  resetTime: string;
  enabled: true;
}

export interface RustUsageSummary {
  request_count: number;
  priced_request_count: number;
  tokens_input: number;
  tokens_output: number;
  tokens_cache_read: number;
  tokens_cache_creation: number;
  tokens_reasoning: number;
  amount_microusd: number;
  pending_request_count: number;
  pending_reserved_tokens: number;
  pending_reserved_microusd: number;
}

export type RustRateLimitScope = "auto" | "connection" | "model";
export type RustProviderAuthScheme = "auto" | "none" | "bearer" | "x-api-key" | "x-goog-api-key";
export type RustProviderOAuthKind =
  "codex" | "claude" | "agy" | "github" | "xai-oauth" | "openference";
export type RustBrowserOAuthKind = Exclude<RustProviderOAuthKind, "github">;
export type RustSessionImportOAuthKind = Exclude<
  RustProviderOAuthKind,
  "github" | "xai-oauth" | "openference"
>;

export const providerApiProtocols = [
  "auto",
  "openai",
  "openai-responses",
  "openai-embeddings",
  "cohere-rerank",
  "anthropic",
  "gemini",
] as const;
export type RustProviderProtocol = (typeof providerApiProtocols)[number];

export interface RustProvider {
  node_id?: string | null;
  protocol?: RustProviderProtocol;
  priority?: number;
  default_model?: string | null;
  id: string;
  tenant_id: string;
  provider: string;
  upstream_url: string;
  enabled: boolean;
  revision: string;
  has_credential: boolean;
  rate_limit_scope: RustRateLimitScope;
  auth_scheme: RustProviderAuthScheme;
  label: string;
  account_email?: string;
  expires_at_unix?: number;
  credential_expired: boolean;
  credential_type: "static" | "oauth";
  oauth_provider?: RustProviderOAuthKind;
  oauth_generation?: string;
  refreshable: boolean;
  oauth_refresh_state?: "ready" | "reauth_required";
  oauth_error_code?: string;
  reauth_required: boolean;
}

export interface RustProviderInput {
  node_id?: string | null;
  protocol?: RustProviderProtocol;
  priority?: number;
  default_model?: string | null;
  tenant_id?: string;
  provider: string;
  upstream_url: string;
  api_key: string;
  enabled: boolean;
  rate_limit_scope: RustRateLimitScope;
  auth_scheme: RustProviderAuthScheme;
  label: string;
  account_email?: string;
  expires_at_unix?: number;
  credential_type?: "static" | "oauth";
  oauth_provider?: RustProviderOAuthKind;
  refresh_token?: string;
}

export interface RustProviderOAuthAuthorization {
  authUrl: string;
  state: string;
  codeVerifier: string;
  codeChallenge: string;
  redirectUri: string;
  flowType: "authorization_code" | "authorization_code_pkce";
  callbackPath: string;
  callbackHost: string;
  fixedPort?: number;
}

export interface RustProviderOAuthExchangeInput {
  code: string;
  redirectUri: string;
  codeVerifier: string;
  state: string;
  connectionId?: string;
}

export interface RustProviderOAuthConnection {
  id: string;
  provider: RustProviderOAuthKind;
  email?: string | null;
  displayName: string;
}

export interface RustProviderSessionImportEntry {
  json: unknown;
  name?: string;
  email?: string;
}

export interface RustProviderSessionImportResult {
  connection: RustProvider;
  created: boolean;
}

export interface RustProviderSessionBulkResult {
  success: number;
  failed: number;
  total: number;
  errors: Array<{ index?: number; name?: string; message?: string }>;
}

export interface RustProviderSessionZipEntry {
  name: string;
  json: unknown | null;
  parseError: string | null;
}

export interface RustProviderOAuthRotationInput {
  expected_generation: string;
  access_token: string;
  refresh_token: string;
  expires_at_unix: number;
}

export type RustProviderOAuthRefreshCategory =
  | "refreshed"
  | "refresh_in_progress"
  | "reauth_required"
  | "superseded"
  | "rate_limited"
  | "request_rejected"
  | "upstream_error"
  | "unavailable"
  | "timeout"
  | "invalid_response"
  | "response_too_large"
  | "unsupported_provider";

export interface RustProviderOAuthRefresh {
  provider_id: string;
  ok: boolean;
  category: RustProviderOAuthRefreshCategory;
  upstream_status?: number;
  generation: string;
  expires_at_unix?: number;
}

export type RustProviderDiagnosticCategory =
  | "ok"
  | "credential_expired"
  | "authentication"
  | "credits_exhausted"
  | "model_unavailable"
  | "rate_limited"
  | "request_rejected"
  | "upstream_error"
  | "unavailable"
  | "timeout"
  | "invalid_response"
  | "response_too_large";

export interface RustProviderDiagnostic {
  provider_id: string;
  model: string;
  ok: boolean;
  category: RustProviderDiagnosticCategory;
  upstream_status?: number;
  latency_ms: number;
}

export interface RustProviderQuotaWindow {
  remaining_percent: number;
  reset_at_unix_ms?: number;
}

export interface RustProviderModelQuota {
  model_id: string;
  session?: RustProviderQuotaWindow;
  weekly?: RustProviderQuotaWindow;
  limit_reached: boolean;
  observed_at_unix_ms: number;
  expires_at_unix_ms: number;
  revision: string;
}

export interface RustProviderQuota {
  provider_id: string;
  models?: RustProviderModelQuota[];
  session?: RustProviderQuotaWindow;
  weekly?: RustProviderQuotaWindow;
  limit_reached: boolean;
  observed_at_unix_ms: number;
  expires_at_unix_ms: number;
  revision: string;
}

export interface RustProviderQuotaInput {
  session?: RustProviderQuotaWindow;
  weekly?: RustProviderQuotaWindow;
  limit_reached: boolean;
  ttl_seconds: number;
}

export type RustProviderQuotaRefreshCategory =
  | "refreshed"
  | "refresh_in_progress"
  | "unsupported_provider"
  | "credential_expired"
  | "credential_unavailable"
  | "session_unavailable"
  | "superseded"
  | "rate_limited"
  | "authorization_failed"
  | "request_rejected"
  | "upstream_error"
  | "unavailable"
  | "timeout"
  | "invalid_response";

export interface RustProviderQuotaRefresh {
  provider_id: string;
  refreshed: boolean;
  category: RustProviderQuotaRefreshCategory;
  quota?: RustProviderQuota;
}

export interface RustProviderModelLockout {
  model: string;
  status: number;
  until_unix_ms: number;
  retry_after_ms: number;
  backoff_level: number;
}

export interface RustProviderHealth {
  provider_id: string;
  state: "closed" | "open" | "half_open";
  failure_count: number;
  retry_after_ms: number;
  open_cycle_count: number;
  failure_threshold: number;
  degradation_threshold: number;
  reset_timeout_ms: number;
  connection_cooldown_until_unix_ms: number;
  connection_retry_after_ms: number;
  connection_backoff_level: number;
  connection_last_status: number | null;
  terminal_status: "banned" | "expired" | "credits_exhausted" | null;
  ambiguous_auth_strikes: number;
  ambiguous_auth_retry_limit: number;
  model_lockouts: RustProviderModelLockout[];
}

export interface RustProviderHealthInput {
  failure_threshold: number;
  degradation_threshold: number;
  reset_timeout_ms: number;
}

export interface RustRuntimeSettings {
  quota_preflight_enabled: boolean;
  quota_preflight_threshold_percent: number;
  oauth_connection_cooldown: RustConnectionCooldownProfile;
  apikey_connection_cooldown: RustConnectionCooldownProfile;
  oauth_provider_breaker: RustProviderBreakerProfile;
  apikey_provider_breaker: RustProviderBreakerProfile;
  revision: string;
}

export interface RustConnectionCooldownProfile {
  base_cooldown_ms: number;
  use_upstream_retry_hints: boolean;
  max_backoff_steps: number;
}

export interface RustProviderBreakerProfile {
  failure_threshold: number;
  degradation_threshold: number;
  reset_timeout_ms: number;
}

export type RustRuntimeSettingsInput = Omit<RustRuntimeSettings, "revision">;

export type RustComboProtocol =
  | "openai"
  | "openai-responses"
  | "openai-embeddings"
  | "cohere-rerank"
  | "anthropic"
  | "openai-to-anthropic"
  | "openai-to-antigravity"
  | "gemini"
  | "antigravity";

export type RustComboStrategy =
  | "priority"
  | "auto"
  | "round-robin"
  | "weighted"
  | "random"
  | "least-used"
  | "p2c"
  | "fill-first"
  | "strict-random"
  | "cost-optimized"
  | "context-optimized"
  | "cache-optimized"
  | "context-relay"
  | "fusion"
  | "pipeline"
  | "reset-aware"
  | "reset-window"
  | "headroom"
  | "quota-weighted"
  | "lkgp";

export interface RustComboModelTarget {
  kind?: never;
  combo_id?: never;
  provider_id: string;
  model: string;
  prompt?: string;
  weight?: number;
  input_cost_per_million?: number;
  output_cost_per_million?: number;
  context_window_tokens?: number;
}

export interface RustComboReferenceTarget {
  kind: "combo-ref";
  combo_id: string;
  provider_id?: never;
  model?: never;
}

export type RustComboTarget = RustComboModelTarget | RustComboReferenceTarget;

export interface RustComboAutoWeights {
  quota: number;
  cost: number;
  context: number;
  load: number;
}

export interface RustComboAutoConfig {
  weights: RustComboAutoWeights;
}

export interface RustComboContextRelayConfig {
  handoffThreshold: number;
  handoffModel?: string;
  handoffProviders: string[];
  maxMessagesForSummary: number;
  relayMode: "standard" | "schema-locked";
}

export interface RustComboFusionConfig {
  judgeModel?: string;
  minPanel: number;
  stragglerGraceMs: number;
  panelTimeoutMs: number;
}

export interface RustComboPipelineConfig {
  maxRetries: number;
  retryDelayMs: number;
}

export interface RustComboRoutePin {
  provider_id: string;
  model: string;
  revision: string;
}

export interface RustCombo {
  id: string;
  tenant_id: string;
  protocol: RustComboProtocol;
  strategy: RustComboStrategy;
  fallback: boolean;
  targets: RustComboTarget[];
  auto?: RustComboAutoConfig;
  context_relay?: RustComboContextRelayConfig;
  fusion?: RustComboFusionConfig;
  pipeline?: RustComboPipelineConfig;
  enabled: boolean;
  revision: string;
  last_known_good?: RustComboRoutePin;
}

export interface RustComboInput {
  tenant_id?: string;
  protocol: RustComboProtocol;
  strategy: RustComboStrategy;
  fallback: boolean;
  targets: RustComboTarget[];
  auto?: RustComboAutoConfig;
  context_relay?: RustComboContextRelayConfig;
  fusion?: RustComboFusionConfig;
  pipeline?: RustComboPipelineConfig;
  enabled: boolean;
}

export interface RustCatalogManifest {
  schemaVersion: number;
  transformVersion: number;
  source: string;
  upstreamRepository: string;
  upstreamSchemaRef: string;
  fetchedAt: string;
  etag: string | null;
  sourceSha256: string;
  contentSha256: string;
  license: string;
  providers: number;
  providerModels: number;
  canonicalModels: number;
}

export interface RustCatalogProviderSummary {
  id: string;
  name: string | null;
}

export interface RustCatalogSnapshot {
  source: string;
  revision: string | null;
  last_error?: string;
}

export interface RustModelCatalogIndex {
  manifest: RustCatalogManifest;
  providers: RustCatalogProviderSummary[];
  snapshot: RustCatalogSnapshot;
}

export interface RustCatalogModel {
  id: string;
  name?: string;
  type?: string;
  canonical_model_id?: string;
  family?: string;
  release_date?: string;
  last_updated?: string;
  status?: string;
  reasoning?: boolean;
  tool_call?: boolean;
  structured_output?: boolean;
  limit?: { context?: number; input?: number; output?: number };
}

export interface RustCatalogProvider {
  id: string;
  name: string | null;
  models: RustCatalogModel[];
}

export interface RustCatalogRefresh {
  changed: boolean;
  source: string;
  revision: string | null;
  manifest: RustCatalogManifest;
}

const CSRF_COOKIE = "redrouter_admin_csrf";
const CSRF_HEADER = "x-red-router-csrf";

export function readRustAdminCsrfCookie(cookie = document.cookie): string | null {
  for (const part of cookie.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === CSRF_COOKIE && value.length > 0) return value.join("=");
  }
  return null;
}

export async function readRustAuthConfig(signal?: AbortSignal): Promise<RustAuthConfig | null> {
  const response = await fetch("/api/auth/config", {
    cache: "no-store",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) return null;
  const value: unknown = await response.json().catch(() => null);
  if (
    !value ||
    typeof value !== "object" ||
    (value as { backend?: unknown }).backend !== "rust" ||
    typeof (value as { control_plane_enabled?: unknown }).control_plane_enabled !== "boolean" ||
    typeof (value as { oidc_browser_login?: unknown }).oidc_browser_login !== "boolean" ||
    typeof (value as { password_login?: unknown }).password_login !== "boolean"
  ) {
    return null;
  }
  return value as RustAuthConfig;
}

export async function readRustRuntimeStatus(signal?: AbortSignal): Promise<RustRuntimeStatus> {
  const request = (path: "/healthz" | "/readyz") =>
    fetch(path, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      signal,
      headers: { accept: "text/plain, application/json" },
    }).then((response) => response.ok);
  const [live, ready] = await Promise.all([request("/healthz"), request("/readyz")]);
  return { live, ready, checked_at: new Date().toISOString() };
}

export async function createRustAdminSession(adminKey: string): Promise<void> {
  if (adminKey.length < 32 || adminKey.length > 512) {
    throw new Error("The administrator key must contain between 32 and 512 characters.");
  }
  const response = await fetch("/api/auth/local/login", {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ admin_key: adminKey }),
  });
  if (!response.ok) {
    const value: unknown = await response.json().catch(() => null);
    throw new Error(rustAdminError(value, response.status));
  }
}

export async function rustAdminFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!path.startsWith("/api/admin/")) {
    throw new TypeError("admin requests must use a same-origin /api/admin/ path");
  }
  const csrf = readRustAdminCsrfCookie();
  if (!csrf) throw new Error("admin session is unavailable");
  const headers = new Headers(init.headers);
  headers.set(CSRF_HEADER, csrf);
  headers.set("Accept", "application/json");
  return fetch(path, {
    ...init,
    cache: init.cache ?? "no-store",
    credentials: "same-origin",
    headers,
  });
}

/** Authenticated browser flow for providers whose authorization-code exchange is Rust-owned. */
export async function rustProviderOAuthFetch(
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  if (
    !/^\/api\/oauth\/(?:codex|claude|agy|xai-oauth|openference)\/(?:authorize|exchange)(?:\?|$)/.test(
      path
    )
  ) {
    throw new TypeError("provider OAuth requests must use a supported same-origin path");
  }
  const csrf = readRustAdminCsrfCookie();
  if (!csrf) throw new Error("admin session is unavailable");
  const headers = new Headers(init.headers);
  headers.set(CSRF_HEADER, csrf);
  headers.set("Accept", "application/json");
  return fetch(path, {
    ...init,
    cache: init.cache ?? "no-store",
    credentials: "same-origin",
    headers,
  });
}

/** Authenticated import surface for Rust-owned CLI provider sessions. */
export async function rustProviderSessionFetch(
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  if (
    !/^\/api\/providers\/(?:codex|claude|agy)-auth\/(?:import|import-bulk|zip-extract)$/.test(path)
  ) {
    throw new TypeError("provider session requests must use a supported same-origin path");
  }
  const csrf = readRustAdminCsrfCookie();
  if (!csrf) throw new Error("admin session is unavailable");
  const headers = new Headers(init.headers);
  headers.set(CSRF_HEADER, csrf);
  headers.set("Accept", "application/json");
  return fetch(path, {
    ...init,
    cache: init.cache ?? "no-store",
    credentials: "same-origin",
    headers,
  });
}

/** Same authenticated browser session, limited to the Rust-owned usage-sink surface. */
export async function rustUsageSinkFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!path.startsWith("/api/usage-sinks")) {
    throw new TypeError("usage-sink requests must use a same-origin /api/usage-sinks path");
  }
  const csrf = readRustAdminCsrfCookie();
  if (!csrf) throw new Error("admin session is unavailable");
  const headers = new Headers(init.headers);
  headers.set(CSRF_HEADER, csrf);
  headers.set("Accept", "application/json");
  return fetch(path, {
    ...init,
    cache: init.cache ?? "no-store",
    credentials: "same-origin",
    headers,
  });
}

/** Authenticated compatibility surface for Rust-owned per-model token limits. */
export async function rustTokenLimitFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!/^\/api\/usage\/token-limits(?:\?|$)/.test(path)) {
    throw new TypeError("token-limit requests must use the same-origin token-limit path");
  }
  const csrf = readRustAdminCsrfCookie();
  if (!csrf) throw new Error("admin session is unavailable");
  const headers = new Headers(init.headers);
  headers.set(CSRF_HEADER, csrf);
  headers.set("Accept", "application/json");
  return fetch(path, {
    ...init,
    cache: init.cache ?? "no-store",
    credentials: "same-origin",
    headers,
  });
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isOptionalNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isOptionalString(value: unknown): value is string | null | undefined {
  return value === null || value === undefined || typeof value === "string";
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeJsonInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0
  );
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRustCatalogLimit(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object") return false;
  const limit = value as Record<string, unknown>;
  return [limit.context, limit.input, limit.output].every(
    (entry) => entry === undefined || isNonNegativeInteger(entry)
  );
}

function isRustClientKey(value: unknown): value is RustClientKey {
  if (!value || typeof value !== "object") return false;
  const key = value as Record<string, unknown>;
  return (
    typeof key.id === "string" &&
    typeof key.label === "string" &&
    typeof key.tenant_id === "string" &&
    typeof key.created_by === "string" &&
    (key.model_id_format === "prefixed" || key.model_id_format === "flat") &&
    (key.model_access_mode === "all" || key.model_access_mode === "restricted") &&
    (key.model_matching === undefined ||
      key.model_matching === "native" ||
      key.model_matching === "legacy-v1") &&
    (key.allowed_combos === null || isStringArray(key.allowed_combos)) &&
    typeof key.enabled === "boolean" &&
    isOptionalNumber(key.expires_at_unix) &&
    isRustClientAccessSchedule(key.access_schedule) &&
    isStringArray(key.scopes) &&
    isStringArray(key.allowed_endpoints) &&
    isStringArray(key.allowed_models) &&
    isStringArray(key.blocked_models) &&
    isStringArray(key.allowed_provider_ids) &&
    isOptionalNumber(key.max_concurrent_requests) &&
    isOptionalNumber(key.max_requests_per_minute) &&
    isOptionalNumber(key.max_requests_per_day) &&
    isOptionalNumber(key.max_tokens_per_minute) &&
    isOptionalNumber(key.max_tokens_per_day) &&
    isOptionalNumber(key.max_spend_per_month_usd) &&
    isOptionalNumber(key.reservation_tokens) &&
    isOptionalNumber(key.reservation_spend_usd) &&
    typeof key.revision === "string"
  );
}

function isRustTenant(value: unknown): value is RustTenant {
  if (!value || typeof value !== "object") return false;
  const tenant = value as Record<string, unknown>;
  return (
    hasOnlyKeys(tenant, ["id", "slug", "name", "enabled", "revision"]) &&
    typeof tenant.id === "string" &&
    typeof tenant.slug === "string" &&
    typeof tenant.name === "string" &&
    typeof tenant.enabled === "boolean" &&
    typeof tenant.revision === "string"
  );
}

function isRustIdentityBinding(value: unknown): value is RustIdentityBinding {
  if (!value || typeof value !== "object") return false;
  const binding = value as Record<string, unknown>;
  return (
    hasOnlyKeys(binding, ["id", "subject", "tenant_id", "role", "enabled", "revision"]) &&
    typeof binding.id === "string" &&
    typeof binding.subject === "string" &&
    typeof binding.tenant_id === "string" &&
    (binding.role === "admin" || binding.role === "tenant-admin" || binding.role === "issuer") &&
    typeof binding.enabled === "boolean" &&
    typeof binding.revision === "string"
  );
}

function isRustAuditEvent(value: unknown): value is RustAuditEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return (
    hasOnlyKeys(event, [
      "id",
      "timestamp",
      "createdAt",
      "action",
      "actor",
      "tenantId",
      "target",
      "resourceType",
      "status",
      "requestId",
      "details",
      "metadata",
      "ip",
      "ipAddress",
    ]) &&
    typeof event.id === "string" &&
    typeof event.timestamp === "string" &&
    typeof event.createdAt === "string" &&
    typeof event.action === "string" &&
    typeof event.actor === "string" &&
    typeof event.tenantId === "string" &&
    typeof event.target === "string" &&
    typeof event.resourceType === "string" &&
    typeof event.status === "string" &&
    typeof event.requestId === "string" &&
    hasOwn(event, "details") &&
    hasOwn(event, "metadata") &&
    hasOwn(event, "ip") &&
    hasOwn(event, "ipAddress") &&
    isOptionalString(event.ip) &&
    isOptionalString(event.ipAddress)
  );
}

function isRustTokenLimit(value: unknown): value is RustTokenLimit {
  if (!value || typeof value !== "object") return false;
  const limit = value as Record<string, unknown>;
  return (
    hasOnlyKeys(limit, [
      "id",
      "apiKeyId",
      "scopeType",
      "scopeValue",
      "tokenLimit",
      "resetInterval",
      "resetTime",
      "enabled",
      "tokensUsed",
      "windowStart",
      "periodStartAt",
      "nextResetAt",
      "remaining",
    ]) &&
    typeof limit.id === "string" &&
    typeof limit.apiKeyId === "string" &&
    limit.scopeType === "model" &&
    typeof limit.scopeValue === "string" &&
    isNonNegativeInteger(limit.tokenLimit) &&
    limit.tokenLimit > 0 &&
    (limit.resetInterval === "daily" ||
      limit.resetInterval === "weekly" ||
      limit.resetInterval === "monthly") &&
    typeof limit.resetTime === "string" &&
    /^([01]\d|2[0-3]):[0-5]\d$/.test(limit.resetTime) &&
    limit.enabled === true &&
    isNonNegativeInteger(limit.tokensUsed) &&
    typeof limit.windowStart === "string" &&
    isNonNegativeJsonInteger(limit.periodStartAt) &&
    isNonNegativeJsonInteger(limit.nextResetAt) &&
    isNonNegativeInteger(limit.remaining)
  );
}

function isRustClientAccessSchedule(value: unknown): value is RustClientAccessSchedule | null {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  const schedule = value as Record<string, unknown>;
  return (
    hasOnlyKeys(schedule, ["enabled", "from", "until", "days", "tz"]) &&
    typeof schedule.enabled === "boolean" &&
    typeof schedule.from === "string" &&
    /^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.from) &&
    typeof schedule.until === "string" &&
    /^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.until) &&
    Array.isArray(schedule.days) &&
    schedule.days.length <= 7 &&
    schedule.days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6) &&
    new Set(schedule.days).size === schedule.days.length &&
    typeof schedule.tz === "string" &&
    schedule.tz.length > 0
  );
}

function isRustProvider(value: unknown): value is RustProvider {
  if (!value || typeof value !== "object") return false;
  const provider = value as Record<string, unknown>;
  return (
    (provider.node_id === undefined ||
      provider.node_id === null ||
      typeof provider.node_id === "string") &&
    !("api_key" in provider) &&
    !("credential" in provider) &&
    !("credential_ciphertext" in provider) &&
    typeof provider.id === "string" &&
    (provider.protocol === undefined ||
      providerApiProtocols.includes(provider.protocol as RustProviderProtocol)) &&
    typeof provider.tenant_id === "string" &&
    typeof provider.provider === "string" &&
    typeof provider.upstream_url === "string" &&
    typeof provider.enabled === "boolean" &&
    typeof provider.revision === "string" &&
    typeof provider.has_credential === "boolean" &&
    typeof provider.label === "string" &&
    (provider.account_email === undefined || typeof provider.account_email === "string") &&
    (provider.expires_at_unix === undefined || isOptionalNumber(provider.expires_at_unix)) &&
    typeof provider.credential_expired === "boolean" &&
    (provider.credential_type === "static" || provider.credential_type === "oauth") &&
    (provider.oauth_provider === undefined ||
      provider.oauth_provider === "codex" ||
      provider.oauth_provider === "claude" ||
      provider.oauth_provider === "agy" ||
      provider.oauth_provider === "github" ||
      provider.oauth_provider === "xai-oauth" ||
      provider.oauth_provider === "openference") &&
    (provider.oauth_generation === undefined || typeof provider.oauth_generation === "string") &&
    typeof provider.refreshable === "boolean" &&
    (provider.oauth_refresh_state === undefined ||
      provider.oauth_refresh_state === "ready" ||
      provider.oauth_refresh_state === "reauth_required") &&
    (provider.oauth_error_code === undefined || typeof provider.oauth_error_code === "string") &&
    typeof provider.reauth_required === "boolean" &&
    (provider.auth_scheme === "auto" ||
      provider.auth_scheme === "none" ||
      provider.auth_scheme === "bearer" ||
      provider.auth_scheme === "x-api-key" ||
      provider.auth_scheme === "x-goog-api-key") &&
    (provider.rate_limit_scope === "auto" ||
      provider.rate_limit_scope === "connection" ||
      provider.rate_limit_scope === "model")
  );
}

const RUST_COMBO_PROTOCOLS: RustComboProtocol[] = [
  "openai",
  "openai-responses",
  "openai-embeddings",
  "cohere-rerank",
  "anthropic",
  "openai-to-anthropic",
  "openai-to-antigravity",
  "gemini",
  "antigravity",
];

const RUST_COMBO_STRATEGIES: RustComboStrategy[] = [
  "priority",
  "auto",
  "round-robin",
  "weighted",
  "random",
  "least-used",
  "p2c",
  "fill-first",
  "strict-random",
  "cost-optimized",
  "context-optimized",
  "cache-optimized",
  "context-relay",
  "fusion",
  "pipeline",
  "reset-aware",
  "reset-window",
  "headroom",
  "quota-weighted",
  "lkgp",
];

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function isRustComboTarget(value: unknown): value is RustComboTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as Record<string, unknown>;
  if (target.kind === "combo-ref") {
    return (
      hasOnlyKeys(target, ["kind", "combo_id"]) &&
      typeof target.combo_id === "string" &&
      /^[A-Za-z0-9_-]{1,128}$/.test(target.combo_id)
    );
  }
  return (
    hasOnlyKeys(target, [
      "provider_id",
      "model",
      "prompt",
      "weight",
      "input_cost_per_million",
      "output_cost_per_million",
      "context_window_tokens",
    ]) &&
    typeof target.provider_id === "string" &&
    typeof target.model === "string" &&
    (target.prompt === undefined ||
      (typeof target.prompt === "string" &&
        target.prompt.length > 0 &&
        target.prompt.length <= 20_000 &&
        !target.prompt.includes("\0"))) &&
    (target.weight === undefined || isNonNegativeInteger(target.weight)) &&
    isOptionalFiniteNumber(target.input_cost_per_million) &&
    isOptionalFiniteNumber(target.output_cost_per_million) &&
    (target.context_window_tokens === undefined ||
      isNonNegativeInteger(target.context_window_tokens))
  );
}

function isRustComboRoutePin(value: unknown): value is RustComboRoutePin {
  if (!value || typeof value !== "object") return false;
  const pin = value as Record<string, unknown>;
  return (
    hasOnlyKeys(pin, ["provider_id", "model", "revision"]) &&
    typeof pin.provider_id === "string" &&
    typeof pin.model === "string" &&
    typeof pin.revision === "string"
  );
}

function isRustComboAutoConfig(value: unknown): value is RustComboAutoConfig {
  if (!value || typeof value !== "object") return false;
  const config = value as Record<string, unknown>;
  if (!hasOnlyKeys(config, ["weights"]) || !config.weights || typeof config.weights !== "object") {
    return false;
  }
  const weights = config.weights as Record<string, unknown>;
  const values = [weights.quota, weights.cost, weights.context, weights.load];
  return (
    hasOnlyKeys(weights, ["quota", "cost", "context", "load"]) &&
    values.every(
      (weight) =>
        typeof weight === "number" && Number.isFinite(weight) && weight >= 0 && weight <= 1
    ) &&
    (values as number[]).reduce((total, weight) => total + weight, 0) > 0
  );
}

function isRustComboContextRelayConfig(value: unknown): value is RustComboContextRelayConfig {
  if (!value || typeof value !== "object") return false;
  const config = value as Record<string, unknown>;
  return (
    hasOnlyKeys(config, [
      "handoffThreshold",
      "handoffModel",
      "handoffProviders",
      "maxMessagesForSummary",
      "relayMode",
    ]) &&
    typeof config.handoffThreshold === "number" &&
    Number.isFinite(config.handoffThreshold) &&
    config.handoffThreshold >= 0.5 &&
    config.handoffThreshold <= 0.94 &&
    (config.handoffModel === undefined || typeof config.handoffModel === "string") &&
    Array.isArray(config.handoffProviders) &&
    config.handoffProviders.length <= 10 &&
    config.handoffProviders.every((provider) => typeof provider === "string") &&
    isNonNegativeInteger(config.maxMessagesForSummary) &&
    (config.maxMessagesForSummary as number) >= 5 &&
    (config.maxMessagesForSummary as number) <= 100 &&
    (config.relayMode === "standard" || config.relayMode === "schema-locked")
  );
}

function isRustComboFusionConfig(value: unknown): value is RustComboFusionConfig {
  if (!value || typeof value !== "object") return false;
  const config = value as Record<string, unknown>;
  return (
    hasOnlyKeys(config, ["judgeModel", "minPanel", "stragglerGraceMs", "panelTimeoutMs"]) &&
    (config.judgeModel === undefined ||
      (typeof config.judgeModel === "string" &&
        config.judgeModel.length <= 256 &&
        !/[\u0000-\u001f\u007f]/.test(config.judgeModel))) &&
    isNonNegativeInteger(config.minPanel) &&
    (config.minPanel as number) >= 1 &&
    (config.minPanel as number) <= 8 &&
    isNonNegativeInteger(config.stragglerGraceMs) &&
    (config.stragglerGraceMs as number) >= 100 &&
    (config.stragglerGraceMs as number) <= 30_000 &&
    isNonNegativeInteger(config.panelTimeoutMs) &&
    (config.panelTimeoutMs as number) >= 1_000 &&
    (config.panelTimeoutMs as number) <= 120_000 &&
    (config.stragglerGraceMs as number) < (config.panelTimeoutMs as number)
  );
}

function isRustComboPipelineConfig(value: unknown): value is RustComboPipelineConfig {
  if (!value || typeof value !== "object") return false;
  const config = value as Record<string, unknown>;
  return (
    hasOnlyKeys(config, ["maxRetries", "retryDelayMs"]) &&
    isNonNegativeInteger(config.maxRetries) &&
    (config.maxRetries as number) <= 10 &&
    isNonNegativeInteger(config.retryDelayMs) &&
    (config.retryDelayMs as number) <= 60_000
  );
}

function isRustCombo(value: unknown): value is RustCombo {
  if (!value || typeof value !== "object") return false;
  const combo = value as Record<string, unknown>;
  return (
    hasOnlyKeys(combo, [
      "id",
      "tenant_id",
      "protocol",
      "strategy",
      "fallback",
      "targets",
      "auto",
      "context_relay",
      "fusion",
      "pipeline",
      "enabled",
      "revision",
      "last_known_good",
    ]) &&
    typeof combo.id === "string" &&
    typeof combo.tenant_id === "string" &&
    RUST_COMBO_PROTOCOLS.includes(combo.protocol as RustComboProtocol) &&
    RUST_COMBO_STRATEGIES.includes(combo.strategy as RustComboStrategy) &&
    typeof combo.fallback === "boolean" &&
    Array.isArray(combo.targets) &&
    combo.targets.every(isRustComboTarget) &&
    (combo.auto === undefined || isRustComboAutoConfig(combo.auto)) &&
    (combo.context_relay === undefined || isRustComboContextRelayConfig(combo.context_relay)) &&
    (combo.fusion === undefined || isRustComboFusionConfig(combo.fusion)) &&
    (combo.pipeline === undefined || isRustComboPipelineConfig(combo.pipeline)) &&
    typeof combo.enabled === "boolean" &&
    typeof combo.revision === "string" &&
    (combo.last_known_good === undefined || isRustComboRoutePin(combo.last_known_good))
  );
}

function isRustProviderOAuthRefresh(value: unknown): value is RustProviderOAuthRefresh {
  if (!value || typeof value !== "object") return false;
  const refresh = value as Record<string, unknown>;
  const categories: RustProviderOAuthRefreshCategory[] = [
    "refreshed",
    "refresh_in_progress",
    "reauth_required",
    "superseded",
    "rate_limited",
    "request_rejected",
    "upstream_error",
    "unavailable",
    "timeout",
    "invalid_response",
    "response_too_large",
    "unsupported_provider",
  ];
  return (
    typeof refresh.provider_id === "string" &&
    typeof refresh.ok === "boolean" &&
    typeof refresh.category === "string" &&
    categories.includes(refresh.category as RustProviderOAuthRefreshCategory) &&
    (refresh.upstream_status === undefined || isOptionalNumber(refresh.upstream_status)) &&
    typeof refresh.generation === "string" &&
    (refresh.expires_at_unix === undefined || isOptionalNumber(refresh.expires_at_unix))
  );
}

function isRustProviderOAuthAuthorization(value: unknown): value is RustProviderOAuthAuthorization {
  if (!value || typeof value !== "object") return false;
  const authorization = value as Record<string, unknown>;
  return (
    !("access_token" in authorization) &&
    !("refresh_token" in authorization) &&
    typeof authorization.authUrl === "string" &&
    typeof authorization.state === "string" &&
    typeof authorization.codeVerifier === "string" &&
    typeof authorization.codeChallenge === "string" &&
    typeof authorization.redirectUri === "string" &&
    (authorization.flowType === "authorization_code" ||
      authorization.flowType === "authorization_code_pkce") &&
    typeof authorization.callbackPath === "string" &&
    typeof authorization.callbackHost === "string" &&
    (authorization.fixedPort === undefined || isNonNegativeInteger(authorization.fixedPort))
  );
}

function isRustProviderOAuthConnection(value: unknown): value is RustProviderOAuthConnection {
  if (!value || typeof value !== "object") return false;
  const connection = value as Record<string, unknown>;
  return (
    !("access_token" in connection) &&
    !("refresh_token" in connection) &&
    !("credential" in connection) &&
    typeof connection.id === "string" &&
    (connection.provider === "codex" ||
      connection.provider === "claude" ||
      connection.provider === "agy" ||
      connection.provider === "xai-oauth" ||
      connection.provider === "openference") &&
    (connection.email === undefined || isOptionalString(connection.email)) &&
    typeof connection.displayName === "string"
  );
}

function isRustProviderSessionImportError(
  value: unknown
): value is RustProviderSessionBulkResult["errors"][number] {
  if (!value || typeof value !== "object") return false;
  const error = value as Record<string, unknown>;
  return (
    (error.index === undefined || isNonNegativeInteger(error.index)) &&
    (error.name === undefined || typeof error.name === "string") &&
    (error.message === undefined || typeof error.message === "string")
  );
}

function isRustProviderSessionZipEntry(value: unknown): value is RustProviderSessionZipEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.name === "string" &&
    (entry.json === null || entry.json === undefined || typeof entry.json === "object") &&
    (entry.parseError === null || typeof entry.parseError === "string")
  );
}

function isRustProviderDiagnostic(value: unknown): value is RustProviderDiagnostic {
  if (!value || typeof value !== "object") return false;
  const diagnostic = value as Record<string, unknown>;
  const categories: RustProviderDiagnosticCategory[] = [
    "ok",
    "credential_expired",
    "authentication",
    "credits_exhausted",
    "model_unavailable",
    "rate_limited",
    "request_rejected",
    "upstream_error",
    "unavailable",
    "timeout",
    "invalid_response",
    "response_too_large",
  ];
  return (
    !("api_key" in diagnostic) &&
    !("credential" in diagnostic) &&
    typeof diagnostic.provider_id === "string" &&
    typeof diagnostic.model === "string" &&
    typeof diagnostic.ok === "boolean" &&
    typeof diagnostic.category === "string" &&
    categories.includes(diagnostic.category as RustProviderDiagnosticCategory) &&
    (diagnostic.upstream_status === undefined ||
      (isNonNegativeInteger(diagnostic.upstream_status) && diagnostic.upstream_status <= 599)) &&
    isNonNegativeInteger(diagnostic.latency_ms)
  );
}

function isRustProviderQuotaWindow(value: unknown): value is RustProviderQuotaWindow {
  if (!value || typeof value !== "object") return false;
  const window = value as Record<string, unknown>;
  return (
    hasOnlyKeys(window, ["remaining_percent", "reset_at_unix_ms"]) &&
    typeof window.remaining_percent === "number" &&
    Number.isFinite(window.remaining_percent) &&
    window.remaining_percent >= 0 &&
    window.remaining_percent <= 100 &&
    (window.reset_at_unix_ms === undefined || isNonNegativeInteger(window.reset_at_unix_ms))
  );
}

function isRustProviderModelQuota(value: unknown): value is RustProviderModelQuota {
  if (!value || typeof value !== "object") return false;
  const quota = value as Record<string, unknown>;
  return (
    hasOnlyKeys(quota, [
      "model_id",
      "session",
      "weekly",
      "limit_reached",
      "observed_at_unix_ms",
      "expires_at_unix_ms",
      "revision",
    ]) &&
    typeof quota.model_id === "string" &&
    quota.model_id.length > 0 &&
    (quota.session === undefined || isRustProviderQuotaWindow(quota.session)) &&
    (quota.weekly === undefined || isRustProviderQuotaWindow(quota.weekly)) &&
    (quota.session !== undefined || quota.weekly !== undefined) &&
    typeof quota.limit_reached === "boolean" &&
    isNonNegativeInteger(quota.observed_at_unix_ms) &&
    isNonNegativeInteger(quota.expires_at_unix_ms) &&
    quota.expires_at_unix_ms >= quota.observed_at_unix_ms &&
    typeof quota.revision === "string"
  );
}

function isRustProviderQuota(value: unknown): value is RustProviderQuota {
  if (!value || typeof value !== "object") return false;
  const quota = value as Record<string, unknown>;
  return (
    hasOnlyKeys(quota, [
      "provider_id",
      "models",
      "session",
      "weekly",
      "limit_reached",
      "observed_at_unix_ms",
      "expires_at_unix_ms",
      "revision",
    ]) &&
    typeof quota.provider_id === "string" &&
    (quota.models === undefined ||
      (Array.isArray(quota.models) && quota.models.every(isRustProviderModelQuota))) &&
    (quota.session === undefined || isRustProviderQuotaWindow(quota.session)) &&
    (quota.weekly === undefined || isRustProviderQuotaWindow(quota.weekly)) &&
    (quota.session !== undefined ||
      quota.weekly !== undefined ||
      (Array.isArray(quota.models) && quota.models.length > 0)) &&
    typeof quota.limit_reached === "boolean" &&
    isNonNegativeInteger(quota.observed_at_unix_ms) &&
    isNonNegativeInteger(quota.expires_at_unix_ms) &&
    quota.expires_at_unix_ms >= quota.observed_at_unix_ms &&
    typeof quota.revision === "string"
  );
}

function isRustProviderQuotaRefresh(value: unknown): value is RustProviderQuotaRefresh {
  if (!value || typeof value !== "object") return false;
  const refresh = value as Record<string, unknown>;
  const categories: RustProviderQuotaRefreshCategory[] = [
    "refreshed",
    "refresh_in_progress",
    "unsupported_provider",
    "credential_expired",
    "credential_unavailable",
    "session_unavailable",
    "superseded",
    "rate_limited",
    "authorization_failed",
    "request_rejected",
    "upstream_error",
    "unavailable",
    "timeout",
    "invalid_response",
  ];
  return (
    hasOnlyKeys(refresh, ["provider_id", "refreshed", "category", "quota"]) &&
    typeof refresh.provider_id === "string" &&
    typeof refresh.refreshed === "boolean" &&
    typeof refresh.category === "string" &&
    categories.includes(refresh.category as RustProviderQuotaRefreshCategory) &&
    (refresh.quota === undefined || isRustProviderQuota(refresh.quota))
  );
}

function isRustProviderModelLockout(value: unknown): value is RustProviderModelLockout {
  if (!value || typeof value !== "object") return false;
  const lockout = value as Record<string, unknown>;
  return (
    hasOnlyKeys(lockout, ["model", "status", "until_unix_ms", "retry_after_ms", "backoff_level"]) &&
    typeof lockout.model === "string" &&
    lockout.model.length > 0 &&
    isNonNegativeInteger(lockout.status) &&
    lockout.status >= 100 &&
    lockout.status <= 599 &&
    isNonNegativeJsonInteger(lockout.until_unix_ms) &&
    isNonNegativeJsonInteger(lockout.retry_after_ms) &&
    isNonNegativeInteger(lockout.backoff_level)
  );
}

function isRustProviderHealth(value: unknown): value is RustProviderHealth {
  if (!value || typeof value !== "object") return false;
  const health = value as Record<string, unknown>;
  return (
    hasOnlyKeys(health, [
      "provider_id",
      "state",
      "failure_count",
      "retry_after_ms",
      "open_cycle_count",
      "failure_threshold",
      "degradation_threshold",
      "reset_timeout_ms",
      "connection_cooldown_until_unix_ms",
      "connection_retry_after_ms",
      "connection_backoff_level",
      "connection_last_status",
      "terminal_status",
      "ambiguous_auth_strikes",
      "ambiguous_auth_retry_limit",
      "model_lockouts",
    ]) &&
    typeof health.provider_id === "string" &&
    health.provider_id.length > 0 &&
    (health.state === "closed" || health.state === "open" || health.state === "half_open") &&
    isNonNegativeInteger(health.failure_count) &&
    isNonNegativeInteger(health.retry_after_ms) &&
    isNonNegativeInteger(health.open_cycle_count) &&
    isNonNegativeInteger(health.failure_threshold) &&
    isNonNegativeInteger(health.degradation_threshold) &&
    isNonNegativeInteger(health.reset_timeout_ms) &&
    isNonNegativeJsonInteger(health.connection_cooldown_until_unix_ms) &&
    isNonNegativeJsonInteger(health.connection_retry_after_ms) &&
    isNonNegativeInteger(health.connection_backoff_level) &&
    (health.connection_last_status === null ||
      (isNonNegativeInteger(health.connection_last_status) &&
        health.connection_last_status >= 100 &&
        health.connection_last_status <= 599)) &&
    (health.terminal_status === null ||
      health.terminal_status === "banned" ||
      health.terminal_status === "expired" ||
      health.terminal_status === "credits_exhausted") &&
    isNonNegativeInteger(health.ambiguous_auth_strikes) &&
    isNonNegativeInteger(health.ambiguous_auth_retry_limit) &&
    Array.isArray(health.model_lockouts) &&
    health.model_lockouts.every(isRustProviderModelLockout)
  );
}

function isRustRuntimeSettings(value: unknown): value is RustRuntimeSettings {
  if (!value || typeof value !== "object") return false;
  const settings = value as Record<string, unknown>;
  return (
    hasOnlyKeys(settings, [
      "quota_preflight_enabled",
      "quota_preflight_threshold_percent",
      "oauth_connection_cooldown",
      "apikey_connection_cooldown",
      "oauth_provider_breaker",
      "apikey_provider_breaker",
      "revision",
    ]) &&
    typeof settings.quota_preflight_enabled === "boolean" &&
    typeof settings.quota_preflight_threshold_percent === "number" &&
    Number.isFinite(settings.quota_preflight_threshold_percent) &&
    settings.quota_preflight_threshold_percent >= 0 &&
    settings.quota_preflight_threshold_percent <= 100 &&
    isRustConnectionCooldownProfile(settings.oauth_connection_cooldown) &&
    isRustConnectionCooldownProfile(settings.apikey_connection_cooldown) &&
    isRustProviderBreakerProfile(settings.oauth_provider_breaker) &&
    isRustProviderBreakerProfile(settings.apikey_provider_breaker) &&
    typeof settings.revision === "string"
  );
}

function isRustProviderBreakerProfile(value: unknown): value is RustProviderBreakerProfile {
  if (!value || typeof value !== "object") return false;
  const profile = value as Record<string, unknown>;
  return (
    hasOnlyKeys(profile, ["failure_threshold", "degradation_threshold", "reset_timeout_ms"]) &&
    isNonNegativeInteger(profile.failure_threshold) &&
    profile.failure_threshold >= 1 &&
    profile.failure_threshold <= 1_000 &&
    isNonNegativeInteger(profile.degradation_threshold) &&
    profile.degradation_threshold >= 1 &&
    profile.degradation_threshold <= profile.failure_threshold &&
    isNonNegativeInteger(profile.reset_timeout_ms) &&
    profile.reset_timeout_ms >= 1_000 &&
    profile.reset_timeout_ms <= 86_400_000
  );
}

function isRustConnectionCooldownProfile(value: unknown): value is RustConnectionCooldownProfile {
  if (!value || typeof value !== "object") return false;
  const profile = value as Record<string, unknown>;
  return (
    hasOnlyKeys(profile, ["base_cooldown_ms", "use_upstream_retry_hints", "max_backoff_steps"]) &&
    isNonNegativeInteger(profile.base_cooldown_ms) &&
    profile.base_cooldown_ms <= 300_000 &&
    typeof profile.use_upstream_retry_hints === "boolean" &&
    isNonNegativeInteger(profile.max_backoff_steps) &&
    profile.max_backoff_steps <= 16
  );
}

function isRustCatalogManifest(value: unknown): value is RustCatalogManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Record<string, unknown>;
  return (
    isNonNegativeInteger(manifest.schemaVersion) &&
    isNonNegativeInteger(manifest.transformVersion) &&
    typeof manifest.source === "string" &&
    typeof manifest.upstreamRepository === "string" &&
    typeof manifest.upstreamSchemaRef === "string" &&
    typeof manifest.fetchedAt === "string" &&
    isOptionalString(manifest.etag) &&
    typeof manifest.sourceSha256 === "string" &&
    typeof manifest.contentSha256 === "string" &&
    typeof manifest.license === "string" &&
    isNonNegativeInteger(manifest.providers) &&
    isNonNegativeInteger(manifest.providerModels) &&
    isNonNegativeInteger(manifest.canonicalModels)
  );
}

function isRustCatalogProviderSummary(value: unknown): value is RustCatalogProviderSummary {
  if (!value || typeof value !== "object") return false;
  const provider = value as Record<string, unknown>;
  return typeof provider.id === "string" && isOptionalString(provider.name);
}

function isRustCatalogSnapshot(value: unknown): value is RustCatalogSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Record<string, unknown>;
  return (
    typeof snapshot.source === "string" &&
    isOptionalString(snapshot.revision) &&
    isOptionalString(snapshot.last_error)
  );
}

function isRustCatalogModel(value: unknown): value is RustCatalogModel {
  if (!value || typeof value !== "object") return false;
  const model = value as Record<string, unknown>;
  return (
    typeof model.id === "string" &&
    isOptionalString(model.name) &&
    isOptionalString(model.type) &&
    isOptionalString(model.canonical_model_id) &&
    isOptionalString(model.family) &&
    isOptionalString(model.release_date) &&
    isOptionalString(model.last_updated) &&
    isOptionalString(model.status) &&
    (model.reasoning === undefined || typeof model.reasoning === "boolean") &&
    (model.tool_call === undefined || typeof model.tool_call === "boolean") &&
    (model.structured_output === undefined || typeof model.structured_output === "boolean") &&
    isRustCatalogLimit(model.limit)
  );
}

async function rustAdminJson(path: string, init?: RequestInit): Promise<unknown> {
  const response = await rustAdminFetch(path, init);
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(rustAdminError(value, response.status));
  }
  return value;
}

function rustAdminError(value: unknown, status: number): string {
  if (value && typeof value === "object") {
    const error = (value as { error?: unknown }).error;
    if (typeof error === "string") return error;
    if (
      error &&
      typeof error === "object" &&
      typeof (error as { message?: unknown }).message === "string"
    ) {
      return (error as { message: string }).message;
    }
  }
  return `Management request failed (${status})`;
}

async function rustError(response: Response): Promise<never> {
  const value: unknown = await response.json().catch(() => null);
  throw new Error(rustAdminError(value, response.status));
}

function jsonRequest(method: "POST" | "PUT", body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export async function listRustTenants(): Promise<RustTenant[]> {
  const value = await rustAdminJson("/api/admin/tenants");
  const tenants =
    value && typeof value === "object" ? (value as { tenants?: unknown }).tenants : null;
  if (!Array.isArray(tenants) || !tenants.every(isRustTenant)) {
    throw new Error("Invalid tenant response");
  }
  return tenants;
}

export async function replaceRustTenant(id: string, input: RustTenantInput): Promise<RustTenant> {
  const value = await rustAdminJson(
    `/api/admin/tenants/${encodeURIComponent(id)}`,
    jsonRequest("PUT", input)
  );
  const tenant = value && typeof value === "object" ? (value as { tenant?: unknown }).tenant : null;
  if (!isRustTenant(tenant)) throw new Error("Invalid tenant response");
  return tenant;
}

export async function listRustIdentityBindings(): Promise<RustIdentityBinding[]> {
  const value = await rustAdminJson("/api/admin/identity-bindings");
  const bindings =
    value && typeof value === "object"
      ? (value as { identity_bindings?: unknown }).identity_bindings
      : null;
  if (!Array.isArray(bindings) || !bindings.every(isRustIdentityBinding)) {
    throw new Error("Invalid identity-binding response");
  }
  return bindings;
}

export async function replaceRustIdentityBinding(
  id: string,
  input: RustIdentityBindingInput
): Promise<RustIdentityBinding> {
  const value = await rustAdminJson(
    `/api/admin/identity-bindings/${encodeURIComponent(id)}`,
    jsonRequest("PUT", input)
  );
  const binding =
    value && typeof value === "object"
      ? (value as { identity_binding?: unknown }).identity_binding
      : null;
  if (!isRustIdentityBinding(binding)) throw new Error("Invalid identity-binding response");
  return binding;
}

export async function deleteRustIdentityBinding(id: string): Promise<void> {
  const response = await rustAdminFetch(`/api/admin/identity-bindings/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!response.ok) await rustError(response);
}

export async function listRustAuditEvents(query: RustAuditQuery = {}): Promise<RustAuditPage> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const suffix = params.size ? `?${params}` : "";
  const response = await rustAdminFetch(`/api/admin/audit-log${suffix}`);
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(rustAdminError(value, response.status));
  if (!Array.isArray(value) || !value.every(isRustAuditEvent)) {
    throw new Error("Invalid audit-log response");
  }
  const totalHeader = response.headers.get("x-total-count");
  const total = totalHeader === null ? Number.NaN : Number(totalHeader);
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error("Invalid audit-log total");
  }
  return { events: value, total };
}

export async function listRustClientKeys(): Promise<RustClientKey[]> {
  const value = await rustAdminJson("/api/admin/client-keys");
  const keys =
    value && typeof value === "object"
      ? (value as { client_keys?: unknown }).client_keys
      : undefined;
  if (!Array.isArray(keys) || !keys.every(isRustClientKey)) {
    throw new Error("Invalid client-key response");
  }
  return keys;
}

export async function listRustSharedBudgets(): Promise<RustSharedBudget[]> {
  const value = (await rustAdminJson("/api/admin/budgets")) as {
    budgets?: RustSharedBudget[];
  };
  if (!Array.isArray(value.budgets)) throw new Error("Invalid shared budget response");
  return value.budgets;
}

export async function createRustSharedBudget(
  input: RustSharedBudgetInput
): Promise<RustSharedBudget> {
  const value = (await rustAdminJson("/api/admin/budgets", jsonRequest("POST", input))) as {
    budget?: RustSharedBudget;
  };
  if (!value.budget) throw new Error("Invalid shared budget response");
  return value.budget;
}

export async function replaceRustSharedBudget(
  id: string,
  input: RustSharedBudgetInput
): Promise<RustSharedBudget> {
  const value = (await rustAdminJson(
    `/api/admin/budgets/${encodeURIComponent(id)}`,
    jsonRequest("PUT", input)
  )) as { budget?: RustSharedBudget };
  if (!value.budget) throw new Error("Invalid shared budget response");
  return value.budget;
}

export async function deleteRustSharedBudget(id: string): Promise<void> {
  await rustAdminJson(`/api/admin/budgets/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function issueRustClientKey(input: RustClientKeyInput): Promise<RustIssuedClientKey> {
  const value = await rustAdminJson("/api/admin/client-keys", jsonRequest("POST", input));
  if (
    !value ||
    typeof value !== "object" ||
    !isRustClientKey((value as { client_key?: unknown }).client_key) ||
    typeof (value as { key?: unknown }).key !== "string" ||
    typeof (value as { warning?: unknown }).warning !== "string"
  ) {
    throw new Error("Invalid client-key issue response");
  }
  return value as RustIssuedClientKey;
}

export async function replaceRustClientKey(
  id: string,
  input: RustClientKeyInput
): Promise<RustClientKey> {
  const value = await rustAdminJson(
    `/api/admin/client-keys/${encodeURIComponent(id)}`,
    jsonRequest("PUT", input)
  );
  const key =
    value && typeof value === "object" ? (value as { client_key?: unknown }).client_key : undefined;
  if (!isRustClientKey(key)) throw new Error("Invalid client-key response");
  return key;
}

export async function deleteRustClientKey(id: string): Promise<void> {
  const response = await rustAdminFetch(`/api/admin/client-keys/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    const value: unknown = await response.json().catch(() => null);
    throw new Error(rustAdminError(value, response.status));
  }
}

export async function listRustTokenLimits(apiKeyId: string): Promise<RustTokenLimit[]> {
  const query = new URLSearchParams({ apiKeyId });
  const response = await rustTokenLimitFetch(`/api/usage/token-limits?${query}`);
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(rustAdminError(value, response.status));
  const limits =
    value && typeof value === "object" ? (value as { limits?: unknown }).limits : undefined;
  if (!Array.isArray(limits) || !limits.every(isRustTokenLimit)) {
    throw new Error("Invalid token-limit response");
  }
  return limits;
}

export async function saveRustTokenLimit(input: RustTokenLimitInput): Promise<RustTokenLimit> {
  const response = await rustTokenLimitFetch("/api/usage/token-limits", jsonRequest("POST", input));
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(rustAdminError(value, response.status));
  const limit =
    value && typeof value === "object" ? (value as { limit?: unknown }).limit : undefined;
  if (!isRustTokenLimit(limit)) throw new Error("Invalid token-limit response");
  return limit;
}

export async function deleteRustTokenLimit(id: string): Promise<void> {
  const query = new URLSearchParams({ id });
  const response = await rustTokenLimitFetch(`/api/usage/token-limits?${query}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    const value: unknown = await response.json().catch(() => null);
    throw new Error(rustAdminError(value, response.status));
  }
}

export async function listRustProviders(): Promise<RustProvider[]> {
  const value = await rustAdminJson("/api/admin/providers");
  const providers =
    value && typeof value === "object" ? (value as { providers?: unknown }).providers : undefined;
  if (!Array.isArray(providers) || !providers.every(isRustProvider)) {
    throw new Error("Invalid provider response");
  }
  return providers;
}

export async function listRustCombos(): Promise<RustCombo[]> {
  const value = await rustAdminJson("/api/admin/combos");
  const combos =
    value && typeof value === "object" ? (value as { combos?: unknown }).combos : undefined;
  if (!Array.isArray(combos) || !combos.every(isRustCombo)) {
    throw new Error("Invalid combo response");
  }
  return combos;
}

export async function replaceRustCombo(id: string, input: RustComboInput): Promise<RustCombo> {
  const value = await rustAdminJson(
    `/api/admin/combos/${encodeURIComponent(id)}`,
    jsonRequest("PUT", input)
  );
  const combo =
    value && typeof value === "object" ? (value as { combo?: unknown }).combo : undefined;
  if (!isRustCombo(combo) || combo.id !== id) throw new Error("Invalid combo response");
  return combo;
}

export async function disableRustCombo(id: string): Promise<void> {
  const response = await rustAdminFetch(`/api/admin/combos/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (response.status !== 204) await rustError(response);
}

export async function clearRustComboRoutePin(id: string): Promise<void> {
  const response = await rustAdminFetch(`/api/admin/combos/${encodeURIComponent(id)}/lkgp`, {
    method: "DELETE",
  });
  if (response.status !== 204) await rustError(response);
}

export async function authorizeRustProviderOAuth(
  provider: RustBrowserOAuthKind,
  redirectUri: string
): Promise<RustProviderOAuthAuthorization> {
  const query = new URLSearchParams({ redirect_uri: redirectUri });
  const response = await rustProviderOAuthFetch(
    `/api/oauth/${provider}/authorize?${query.toString()}`
  );
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(rustAdminError(value, response.status));
  if (!isRustProviderOAuthAuthorization(value)) {
    throw new Error("Invalid provider OAuth authorization response");
  }
  return value;
}

export async function exchangeRustProviderOAuth(
  provider: RustBrowserOAuthKind,
  input: RustProviderOAuthExchangeInput
): Promise<RustProviderOAuthConnection> {
  const response = await rustProviderOAuthFetch(
    `/api/oauth/${provider}/exchange`,
    jsonRequest("POST", input)
  );
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(rustAdminError(value, response.status));
  const connection =
    value && typeof value === "object"
      ? (value as { success?: unknown; connection?: unknown }).connection
      : undefined;
  if (
    !value ||
    typeof value !== "object" ||
    (value as { success?: unknown }).success !== true ||
    !isRustProviderOAuthConnection(connection)
  ) {
    throw new Error("Invalid provider OAuth exchange response");
  }
  return connection;
}

export async function importRustProviderSession(
  provider: RustSessionImportOAuthKind,
  entry: RustProviderSessionImportEntry,
  overwriteExisting: boolean
): Promise<RustProviderSessionImportResult> {
  const response = await rustProviderSessionFetch(
    `/api/providers/${provider}-auth/import`,
    jsonRequest("POST", {
      source: { kind: "json", json: entry.json },
      ...(entry.name ? { name: entry.name } : {}),
      ...(entry.email ? { email: entry.email } : {}),
      overwriteExisting,
    })
  );
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(rustAdminError(value, response.status));
  if (
    !value ||
    typeof value !== "object" ||
    !isRustProvider((value as { connection?: unknown }).connection) ||
    typeof (value as { created?: unknown }).created !== "boolean"
  ) {
    throw new Error("Invalid provider session import response");
  }
  return value as RustProviderSessionImportResult;
}

export async function importRustProviderSessionsBulk(
  provider: RustSessionImportOAuthKind,
  entries: RustProviderSessionImportEntry[],
  overwriteExisting: boolean
): Promise<RustProviderSessionBulkResult> {
  const response = await rustProviderSessionFetch(
    `/api/providers/${provider}-auth/import-bulk`,
    jsonRequest("POST", { entries, overwriteExisting })
  );
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(rustAdminError(value, response.status));
  if (!value || typeof value !== "object") {
    throw new Error("Invalid provider bulk import response");
  }
  const result = value as Record<string, unknown>;
  if (
    !isNonNegativeInteger(result.success) ||
    !isNonNegativeInteger(result.failed) ||
    !isNonNegativeInteger(result.total) ||
    result.success + result.failed !== result.total ||
    !Array.isArray(result.errors) ||
    !result.errors.every(isRustProviderSessionImportError)
  ) {
    throw new Error("Invalid provider bulk import response");
  }
  return {
    success: result.success,
    failed: result.failed,
    total: result.total,
    errors: result.errors,
  };
}

export async function extractRustProviderSessionZip(
  provider: RustSessionImportOAuthKind,
  file: Blob
): Promise<RustProviderSessionZipEntry[]> {
  const response = await rustProviderSessionFetch(`/api/providers/${provider}-auth/zip-extract`, {
    method: "POST",
    headers: { "Content-Type": "application/zip" },
    body: file,
  });
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(rustAdminError(value, response.status));
  const entries =
    value && typeof value === "object" ? (value as { entries?: unknown }).entries : undefined;
  if (!Array.isArray(entries) || !entries.every(isRustProviderSessionZipEntry)) {
    throw new Error("Invalid provider ZIP response");
  }
  return entries;
}

export async function replaceRustProvider(
  id: string,
  input: RustProviderInput
): Promise<RustProvider> {
  const value = await rustAdminJson(
    `/api/admin/providers/${encodeURIComponent(id)}`,
    jsonRequest("PUT", input)
  );
  const provider =
    value && typeof value === "object" ? (value as { provider?: unknown }).provider : undefined;
  if (!isRustProvider(provider)) throw new Error("Invalid provider response");
  return provider;
}

export async function disableRustProvider(id: string): Promise<void> {
  const response = await rustAdminFetch(`/api/admin/providers/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    const value: unknown = await response.json().catch(() => null);
    throw new Error(rustAdminError(value, response.status));
  }
}

export async function deleteRustProvider(id: string): Promise<void> {
  const response = await rustAdminFetch(`/api/admin/providers/${encodeURIComponent(id)}/purge`, {
    method: "DELETE",
  });
  if (!response.ok) {
    const value: unknown = await response.json().catch(() => null);
    throw new Error(rustAdminError(value, response.status));
  }
}

export async function rotateRustProviderOAuth(
  id: string,
  input: RustProviderOAuthRotationInput
): Promise<RustProvider> {
  const value = await rustAdminJson(
    `/api/admin/providers/${encodeURIComponent(id)}/oauth/rotate`,
    jsonRequest("POST", input)
  );
  const provider =
    value && typeof value === "object" ? (value as { provider?: unknown }).provider : undefined;
  if (!isRustProvider(provider)) throw new Error("Invalid provider response");
  return provider;
}

export async function refreshRustProviderOAuth(id: string): Promise<RustProviderOAuthRefresh> {
  const value = await rustAdminJson(
    `/api/admin/providers/${encodeURIComponent(id)}/oauth/refresh`,
    jsonRequest("POST", {})
  );
  const refresh =
    value && typeof value === "object" ? (value as { refresh?: unknown }).refresh : undefined;
  if (!isRustProviderOAuthRefresh(refresh)) {
    throw new Error("Invalid provider OAuth refresh response");
  }
  return refresh;
}

export async function listRustProviderQuotas(): Promise<RustProviderQuota[]> {
  const value = await rustAdminJson("/api/admin/provider-quotas");
  const quotas =
    value && typeof value === "object"
      ? (value as { provider_quotas?: unknown }).provider_quotas
      : undefined;
  if (!Array.isArray(quotas) || !quotas.every(isRustProviderQuota)) {
    throw new Error("Invalid provider quota response");
  }
  return quotas;
}

export async function configureRustProviderQuota(
  id: string,
  input: RustProviderQuotaInput
): Promise<RustProviderQuota> {
  const value = await rustAdminJson(
    `/api/admin/provider-quotas/${encodeURIComponent(id)}`,
    jsonRequest("PUT", input)
  );
  const quota =
    value && typeof value === "object"
      ? (value as { provider_quota?: unknown }).provider_quota
      : undefined;
  if (!isRustProviderQuota(quota) || quota.provider_id !== id) {
    throw new Error("Invalid provider quota response");
  }
  return quota;
}

export async function clearRustProviderQuota(id: string): Promise<void> {
  const response = await rustAdminFetch(`/api/admin/provider-quotas/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (response.status !== 204) await rustError(response);
}

export async function listRustProviderHealth(): Promise<RustProviderHealth[]> {
  const value = await rustAdminJson("/api/admin/provider-health");
  const health =
    value && typeof value === "object"
      ? (value as { provider_health?: unknown }).provider_health
      : undefined;
  if (!Array.isArray(health) || !health.every(isRustProviderHealth)) {
    throw new Error("Invalid provider health response");
  }
  return health;
}

export async function resetRustProviderHealth(id: string): Promise<void> {
  const response = await rustAdminFetch(`/api/admin/provider-health/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (response.status !== 204) await rustError(response);
}

export async function configureRustProviderHealth(
  id: string,
  input: RustProviderHealthInput
): Promise<void> {
  const response = await rustAdminFetch(`/api/admin/provider-health/${encodeURIComponent(id)}`, {
    ...jsonRequest("PUT", input),
  });
  if (!response.ok) await rustError(response);
}

export async function readRustRuntimeSettings(): Promise<RustRuntimeSettings> {
  const value = await rustAdminJson("/api/admin/runtime-settings");
  const settings =
    value && typeof value === "object"
      ? (value as { runtime_settings?: unknown }).runtime_settings
      : undefined;
  if (!isRustRuntimeSettings(settings)) {
    throw new Error("Invalid runtime settings response");
  }
  return settings;
}

export async function saveRustRuntimeSettings(
  input: RustRuntimeSettingsInput
): Promise<RustRuntimeSettings> {
  const value = await rustAdminJson("/api/admin/runtime-settings", jsonRequest("PUT", input));
  const settings =
    value && typeof value === "object"
      ? (value as { runtime_settings?: unknown }).runtime_settings
      : undefined;
  if (!isRustRuntimeSettings(settings)) {
    throw new Error("Invalid runtime settings response");
  }
  return settings;
}

export async function refreshRustProviderQuota(id: string): Promise<RustProviderQuotaRefresh> {
  const value = await rustAdminJson(
    `/api/admin/provider-quotas/${encodeURIComponent(id)}/refresh`,
    {
      method: "POST",
    }
  );
  const refresh =
    value && typeof value === "object" ? (value as { refresh?: unknown }).refresh : undefined;
  if (!isRustProviderQuotaRefresh(refresh) || refresh.provider_id !== id) {
    throw new Error("Invalid provider quota refresh response");
  }
  return refresh;
}

export async function testRustProvider(id: string, model: string): Promise<RustProviderDiagnostic> {
  const value = await rustAdminJson(
    `/api/admin/providers/${encodeURIComponent(id)}/test`,
    jsonRequest("POST", { model })
  );
  const diagnostic =
    value && typeof value === "object" ? (value as { diagnostic?: unknown }).diagnostic : undefined;
  if (!isRustProviderDiagnostic(diagnostic)) {
    throw new Error("Invalid provider diagnostic response");
  }
  return diagnostic;
}

export async function readRustModelCatalog(): Promise<RustModelCatalogIndex> {
  const value = await rustAdminJson("/api/admin/model-catalog");
  if (!value || typeof value !== "object") throw new Error("Invalid model catalog response");
  const catalog = value as Record<string, unknown>;
  if (
    !isRustCatalogManifest(catalog.manifest) ||
    !Array.isArray(catalog.providers) ||
    !catalog.providers.every(isRustCatalogProviderSummary) ||
    !isRustCatalogSnapshot(catalog.snapshot)
  ) {
    throw new Error("Invalid model catalog response");
  }
  return value as RustModelCatalogIndex;
}

export async function readRustCatalogProvider(id: string): Promise<RustCatalogProvider> {
  const value = await rustAdminJson(`/api/admin/model-catalog/${encodeURIComponent(id)}`);
  const provider =
    value && typeof value === "object" ? (value as { provider?: unknown }).provider : undefined;
  if (!provider || typeof provider !== "object") {
    throw new Error("Invalid catalog provider response");
  }
  const record = provider as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    !isOptionalString(record.name) ||
    !Array.isArray(record.models) ||
    !record.models.every(isRustCatalogModel)
  ) {
    throw new Error("Invalid catalog provider response");
  }
  return provider as RustCatalogProvider;
}

export async function refreshRustModelCatalog(): Promise<RustCatalogRefresh> {
  const value = await rustAdminJson("/api/admin/model-catalog/refresh", { method: "POST" });
  const snapshot =
    value && typeof value === "object" ? (value as { snapshot?: unknown }).snapshot : undefined;
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error("Invalid catalog refresh response");
  }
  const refresh = snapshot as Record<string, unknown>;
  if (
    typeof refresh.changed !== "boolean" ||
    typeof refresh.source !== "string" ||
    !isOptionalString(refresh.revision) ||
    !isRustCatalogManifest(refresh.manifest)
  ) {
    throw new Error("Invalid catalog refresh response");
  }
  return snapshot as RustCatalogRefresh;
}

export async function readRustUsageSummary(keyId?: string): Promise<RustUsageSummary> {
  const query = keyId ? `?key_id=${encodeURIComponent(keyId)}&limit=1` : "?limit=1";
  const value = await rustAdminJson(`/api/admin/usage${query}`);
  const usage = value && typeof value === "object" ? (value as { usage?: unknown }).usage : null;
  if (!usage || typeof usage !== "object") throw new Error("Invalid usage response");
  const summary = usage as Record<string, unknown>;
  const fields: Array<keyof RustUsageSummary> = [
    "request_count",
    "priced_request_count",
    "tokens_input",
    "tokens_output",
    "tokens_cache_read",
    "tokens_cache_creation",
    "tokens_reasoning",
    "amount_microusd",
    "pending_request_count",
    "pending_reserved_tokens",
    "pending_reserved_microusd",
  ];
  if (fields.some((field) => typeof summary[field] !== "number")) {
    throw new Error("Invalid usage response");
  }
  return summary as unknown as RustUsageSummary;
}

export interface ProviderHeadersView {
  names: string[];
  attached: boolean;
  revision: string | null;
}

export interface ProviderModelRulesView {
  excluded_models: string[];
  revision: string | null;
}
export async function providerModelRules(
  id: string,
  update?: ProviderModelRulesView
): Promise<ProviderModelRulesView> {
  const value = await rustAdminJson(
    `/api/admin/providers/${encodeURIComponent(id)}/model-rules`,
    update === undefined ? undefined : jsonRequest("PUT", update)
  );
  if (!value || typeof value !== "object") throw new Error("Invalid model exclusions response");
  const view = value as ProviderModelRulesView;
  if (!Array.isArray(view.excluded_models) || view.excluded_models.length > 128 ||
      !view.excluded_models.every((pattern) => typeof pattern === "string") ||
      (view.revision !== null && typeof view.revision !== "string")) {
    throw new Error("Invalid model exclusions response");
  }
  return view;
}

export function providerRequestHeaders(
  id: string,
  headers?: Record<string, string>
): Promise<ProviderHeadersView> {
  return requestHeaderMap(`/api/admin/providers/${encodeURIComponent(id)}/headers`, headers);
}
export function providerDefinitionHeaders(
  id: string,
  headers?: Record<string, string>
): Promise<ProviderHeadersView> {
  return requestHeaderMap(`/api/admin/provider-nodes/${encodeURIComponent(id)}/headers`, headers);
}
async function requestHeaderMap(
  path: string,
  headers?: Record<string, string>
): Promise<ProviderHeadersView> {
  const value = await rustAdminJson(
    path,
    headers === undefined ? undefined : jsonRequest("PUT", { headers })
  );
  if (!value || typeof value !== "object") throw new Error("Invalid provider headers response");
  const view = value as ProviderHeadersView;
  if (
    !Array.isArray(view.names) ||
    !view.names.every((name) => typeof name === "string") ||
    typeof view.attached !== "boolean" ||
    (view.revision !== null && typeof view.revision !== "string")
  ) {
    throw new Error("Invalid provider headers response");
  }
  return view;
}

export interface ProviderDiscoveryConfig {
  models_path: string | null;
  effective_models_path: string | null;
  revision: string | null;
  legacy_inventory_available?: boolean;
  legacy_inventory_unverified?: boolean;
}
export interface DiscoveredProviderModel {
  id: string;
  name?: string;
  context_length?: number;
  max_output_tokens?: number;
}
export async function providerDiscoveryConfig(
  id: string,
  path?: string | null
): Promise<ProviderDiscoveryConfig> {
  const value = await rustAdminJson(
    `/api/admin/providers/${encodeURIComponent(id)}/discovery`,
    path === undefined ? undefined : jsonRequest("PUT", { models_path: path })
  );
  if (!value || typeof value !== "object") throw new Error("Invalid discovery configuration");
  const config = value as ProviderDiscoveryConfig;
  if (
    ![config.models_path, config.effective_models_path, config.revision].every(
      (entry) => entry === null || typeof entry === "string"
    ) ||
    (config.legacy_inventory_available !== undefined &&
      typeof config.legacy_inventory_available !== "boolean") ||
    (config.legacy_inventory_unverified !== undefined &&
      typeof config.legacy_inventory_unverified !== "boolean")
  ) {
    throw new Error("Invalid discovery configuration");
  }
  return config;
}
export async function adoptLegacyProviderModels(id: string): Promise<number> {
  const value = await rustAdminJson(
    `/api/admin/providers/${encodeURIComponent(id)}/discovery/adopt-legacy`,
    jsonRequest("POST", {})
  );
  if (!value || typeof value !== "object") throw new Error("Invalid restored model list");
  const result = value as { provider_id?: unknown; adopted_models?: unknown; age_known?: unknown };
  if (
    result.provider_id !== id ||
    typeof result.adopted_models !== "number" ||
    !Number.isInteger(result.adopted_models) ||
    result.adopted_models < 0 ||
    result.adopted_models > 10_000 ||
    result.age_known !== false
  ) throw new Error("Invalid restored model list");
  return result.adopted_models;
}
export async function discoverProviderModels(id: string): Promise<DiscoveredProviderModel[]> {
  const value = await rustAdminJson(
    `/api/admin/providers/${encodeURIComponent(id)}/discovery`,
    jsonRequest("POST", {})
  );
  if (!value || typeof value !== "object") throw new Error("Invalid discovered model list");
  const { models, provider_id: providerId } = value as { models?: unknown; provider_id?: unknown };
  if (
    providerId !== id ||
    !Array.isArray(models) ||
    models.length > 10_000 ||
    !models.every(
      (model) =>
        model &&
        typeof model === "object" &&
        typeof model.id === "string" &&
        (model.name === undefined || typeof model.name === "string") &&
        [model.context_length, model.max_output_tokens].every(
          (limit) =>
            limit === undefined ||
            (typeof limit === "number" && Number.isFinite(limit) && limit >= 0)
        )
    )
  ) {
    throw new Error("Invalid discovered model list");
  }
  return models as DiscoveredProviderModel[];
}

export interface ProviderNode {
  id: string;
  tenant_id: string;
  name: string;
  prefix: string;
  protocol: RustProviderProtocol;
  base_url: string;
  chat_path: string;
  upstream_url: string;
  models_path: string | null;
  revision: string;
}
export type ProviderNodeInput = Omit<
  ProviderNode,
  "id" | "tenant_id" | "revision" | "upstream_url"
> & {
  tenant_id?: string;
  apply_to_connections?: boolean;
};
function isProviderNode(value: unknown): value is ProviderNode {
  if (!value || typeof value !== "object") return false;
  const node = value as Record<string, unknown>;
  return (
    [
      "id",
      "tenant_id",
      "name",
      "prefix",
      "base_url",
      "chat_path",
      "upstream_url",
      "revision",
    ].every((key) => typeof node[key] === "string") &&
    providerApiProtocols.includes(node.protocol as RustProviderProtocol) &&
    node.protocol !== "auto" &&
    (node.models_path === null || typeof node.models_path === "string")
  );
}
export async function listProviderNodes(): Promise<ProviderNode[]> {
  const value = await rustAdminJson("/api/admin/provider-nodes");
  const nodes =
    value && typeof value === "object" ? (value as { nodes?: unknown }).nodes : undefined;
  if (!Array.isArray(nodes) || !nodes.every(isProviderNode))
    throw new Error("Invalid provider definitions response");
  return nodes;
}
export async function saveProviderNode(
  id: string,
  input: ProviderNodeInput
): Promise<ProviderNode> {
  const value = await rustAdminJson(
    `/api/admin/provider-nodes/${encodeURIComponent(id)}`,
    jsonRequest("PUT", input)
  );
  const node = value && typeof value === "object" ? (value as { node?: unknown }).node : undefined;
  if (!isProviderNode(node)) throw new Error("Invalid provider definition response");
  return node;
}
export async function deleteProviderNode(id: string): Promise<void> {
  const response = await rustAdminFetch(`/api/admin/provider-nodes/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    const value: unknown = await response.json().catch(() => null);
    throw new Error(rustAdminError(value, response.status));
  }
}
