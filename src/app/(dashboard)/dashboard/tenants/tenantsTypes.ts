export interface TenantRow {
  id: string;
  slug: string;
  name: string;
  isDefault: boolean;
  disabled: boolean;
  admins: number;
  users: number;
  apiKeys: number;
  connections: number;
  combos: number;
}

export interface TenantUserRow {
  id: string;
  tenantId: string;
  email: string;
  displayName: string | null;
  role: "admin" | "user";
  disabled: boolean;
}

export interface ResourceRow {
  id: string;
  name: string;
  tenantId: string;
  shared: boolean;
  detail?: string;
}

export interface ResourceLists {
  connections: ResourceRow[];
  combos: ResourceRow[];
  apiKeys: ResourceRow[];
}

export const JSON_HEADERS = { "Content-Type": "application/json" };

/** The message of an API error body, or the fallback. */
export function errorText(data: unknown, fallback: string): string {
  const error = (data as { error?: unknown } | null)?.error;
  if (typeof error === "string") return error;
  const message = (error as { message?: unknown } | undefined)?.message;
  return typeof message === "string" && message ? message : fallback;
}
