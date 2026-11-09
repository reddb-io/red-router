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
