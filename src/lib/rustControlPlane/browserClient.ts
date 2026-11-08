export interface RustAuthConfig {
  backend: "rust";
  control_plane_enabled: boolean;
  oidc_browser_login: boolean;
  password_login: false;
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
