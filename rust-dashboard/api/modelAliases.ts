import { rustAdminFetch } from "./browserClient";

export interface ModelAlias {
  id: string;
  tenant_id: string;
  alias: string;
  provider: string;
  model: string;
  protocol: string;
  enabled: boolean;
  revision: string;
}
export interface AliasInput {
  tenant_id?: string;
  alias: string;
  provider: string;
  model: string;
  protocol: string;
  enabled: boolean;
  revision?: string;
}
export interface AliasPage {
  aliases: ModelAlias[];
  total: number;
  offset: number;
  limit: number;
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
function alias(value: unknown): value is ModelAlias {
  return (
    object(value) &&
    ["id", "tenant_id", "alias", "provider", "model", "protocol", "revision"].every(
      (key) => typeof value[key] === "string"
    ) &&
    typeof value.enabled === "boolean"
  );
}
async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await rustAdminFetch(path, init);
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(body?.error?.message || body?.error || `Request failed (${response.status})`);
  return body;
}
export async function listModelAliases(
  filters: { tenant?: string; provider?: string; offset?: number } = {},
  signal?: AbortSignal
): Promise<AliasPage> {
  const query = new URLSearchParams({ offset: String(filters.offset ?? 0), limit: "50" });
  if (filters.tenant) query.set("tenant_id", filters.tenant);
  if (filters.provider) query.set("provider", filters.provider);
  const value = await request(`/api/admin/model-aliases?${query}`, { signal });
  if (
    !object(value) ||
    !Array.isArray(value.aliases) ||
    !value.aliases.every(alias) ||
    ![value.total, value.offset, value.limit].every(
      (n) => Number.isSafeInteger(n) && (n as number) >= 0
    )
  )
    throw new Error("Invalid model alias response");
  return value as unknown as AliasPage;
}
export async function saveModelAlias(input: AliasInput, id?: string): Promise<ModelAlias> {
  const value = await request(`/api/admin/model-aliases${id ? `/${encodeURIComponent(id)}` : ""}`, {
    method: id ? "PUT" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!object(value) || !alias(value.alias)) throw new Error("Invalid model alias response");
  return value.alias;
}
export async function readModelAlias(id: string): Promise<ModelAlias> {
  const value = await request(`/api/admin/model-aliases/${encodeURIComponent(id)}`);
  if (!object(value) || !alias(value.alias)) throw new Error("Invalid model alias response");
  return value.alias;
}
export async function deleteModelAlias(row: ModelAlias): Promise<void> {
  const value = await request(
    `/api/admin/model-aliases/${encodeURIComponent(row.id)}?${new URLSearchParams({ revision: row.revision })}`,
    { method: "DELETE" }
  );
  if (!object(value) || value.deleted !== true) throw new Error("Alias removal was not confirmed");
}
