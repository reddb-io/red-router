export interface RustAuthConfig {
  backend: "rust";
  control_plane_enabled: boolean;
  oidc_browser_login: boolean;
  password_login: false;
}

export interface RustClientKey {
  id: string;
  label: string;
  tenant_id: string;
  created_by: string;
  model_id_format: "prefixed" | "flat";
  enabled: boolean;
  expires_at_unix: number | null;
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
  "id" | "tenant_id" | "created_by" | "revision" | "expires_at_unix"
> & {
  tenant_id?: string;
  expires_at_unix?: number | null;
};

export interface RustIssuedClientKey {
  client_key: RustClientKey;
  key: string;
  warning: string;
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
export type RustProviderAuthScheme = "auto" | "bearer" | "x-api-key" | "x-goog-api-key";

export interface RustProvider {
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
}

export interface RustProviderInput {
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
    (value as { password_login?: unknown }).password_login !== false
  ) {
    return null;
  }
  return value as RustAuthConfig;
}

export async function rustAdminFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!path.startsWith("/api/admin/")) {
    throw new TypeError("Rust admin requests must use a same-origin /api/admin/ path");
  }
  const csrf = readRustAdminCsrfCookie();
  if (!csrf) throw new Error("Rust admin session is unavailable");
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
    typeof key.enabled === "boolean" &&
    isOptionalNumber(key.expires_at_unix) &&
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

function isRustProvider(value: unknown): value is RustProvider {
  if (!value || typeof value !== "object") return false;
  const provider = value as Record<string, unknown>;
  return (
    !("api_key" in provider) &&
    !("credential" in provider) &&
    !("credential_ciphertext" in provider) &&
    typeof provider.id === "string" &&
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
    (provider.auth_scheme === "auto" ||
      provider.auth_scheme === "bearer" ||
      provider.auth_scheme === "x-api-key" ||
      provider.auth_scheme === "x-goog-api-key") &&
    (provider.rate_limit_scope === "auto" ||
      provider.rate_limit_scope === "connection" ||
      provider.rate_limit_scope === "model")
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
  return `Rust control-plane request failed (${status})`;
}

function jsonRequest(method: "POST" | "PUT", body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export async function listRustClientKeys(): Promise<RustClientKey[]> {
  const value = await rustAdminJson("/api/admin/client-keys");
  const keys =
    value && typeof value === "object"
      ? (value as { client_keys?: unknown }).client_keys
      : undefined;
  if (!Array.isArray(keys) || !keys.every(isRustClientKey)) {
    throw new Error("Invalid Rust client-key response");
  }
  return keys;
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
    throw new Error("Invalid Rust client-key issue response");
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
  if (!isRustClientKey(key)) throw new Error("Invalid Rust client-key response");
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

export async function listRustProviders(): Promise<RustProvider[]> {
  const value = await rustAdminJson("/api/admin/providers");
  const providers =
    value && typeof value === "object" ? (value as { providers?: unknown }).providers : undefined;
  if (!Array.isArray(providers) || !providers.every(isRustProvider)) {
    throw new Error("Invalid Rust provider response");
  }
  return providers;
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
  if (!isRustProvider(provider)) throw new Error("Invalid Rust provider response");
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

export async function readRustModelCatalog(): Promise<RustModelCatalogIndex> {
  const value = await rustAdminJson("/api/admin/model-catalog");
  if (!value || typeof value !== "object") throw new Error("Invalid Rust model catalog response");
  const catalog = value as Record<string, unknown>;
  if (
    !isRustCatalogManifest(catalog.manifest) ||
    !Array.isArray(catalog.providers) ||
    !catalog.providers.every(isRustCatalogProviderSummary) ||
    !isRustCatalogSnapshot(catalog.snapshot)
  ) {
    throw new Error("Invalid Rust model catalog response");
  }
  return value as RustModelCatalogIndex;
}

export async function readRustCatalogProvider(id: string): Promise<RustCatalogProvider> {
  const value = await rustAdminJson(`/api/admin/model-catalog/${encodeURIComponent(id)}`);
  const provider =
    value && typeof value === "object" ? (value as { provider?: unknown }).provider : undefined;
  if (!provider || typeof provider !== "object") {
    throw new Error("Invalid Rust catalog provider response");
  }
  const record = provider as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    !isOptionalString(record.name) ||
    !Array.isArray(record.models) ||
    !record.models.every(isRustCatalogModel)
  ) {
    throw new Error("Invalid Rust catalog provider response");
  }
  return provider as RustCatalogProvider;
}

export async function refreshRustModelCatalog(): Promise<RustCatalogRefresh> {
  const value = await rustAdminJson("/api/admin/model-catalog/refresh", { method: "POST" });
  const snapshot =
    value && typeof value === "object" ? (value as { snapshot?: unknown }).snapshot : undefined;
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error("Invalid Rust catalog refresh response");
  }
  const refresh = snapshot as Record<string, unknown>;
  if (
    typeof refresh.changed !== "boolean" ||
    typeof refresh.source !== "string" ||
    !isOptionalString(refresh.revision) ||
    !isRustCatalogManifest(refresh.manifest)
  ) {
    throw new Error("Invalid Rust catalog refresh response");
  }
  return snapshot as RustCatalogRefresh;
}

export async function readRustUsageSummary(keyId?: string): Promise<RustUsageSummary> {
  const query = keyId ? `?key_id=${encodeURIComponent(keyId)}&limit=1` : "?limit=1";
  const value = await rustAdminJson(`/api/admin/usage${query}`);
  const usage = value && typeof value === "object" ? (value as { usage?: unknown }).usage : null;
  if (!usage || typeof usage !== "object") throw new Error("Invalid Rust usage response");
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
    throw new Error("Invalid Rust usage response");
  }
  return summary as unknown as RustUsageSummary;
}
