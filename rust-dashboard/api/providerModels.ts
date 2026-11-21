import { rustAdminFetch } from "./browserClient";
import type { CatalogModel } from "../catalogModels";

export interface ProviderModel {
  id: string;
  tenant_id: string;
  provider: string;
  metadata: CatalogModel;
  effective: CatalogModel;
  hidden?: boolean;
  visibility_only?: boolean;
  revision: string;
}
export interface ProviderModelPage {
  models: ProviderModel[];
  total: number;
  offset: number;
  limit: number;
}
export interface ProviderModelInput {
  tenant_id?: string;
  provider: string;
  metadata: CatalogModel;
  hidden?: boolean;
  visibility_only?: boolean;
  revision?: string;
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await rustAdminFetch(path, init);
  const value = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(value?.error?.message || value?.error || `Request failed (${response.status})`);
  return value;
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
function model(value: unknown): value is ProviderModel {
  return (
    record(value) &&
    ["id", "tenant_id", "provider", "revision"].every((key) => typeof value[key] === "string") &&
    record(value.metadata) &&
    typeof value.metadata.id === "string" &&
    record(value.effective) &&
    typeof value.effective.id === "string" &&
    (value.hidden === undefined || typeof value.hidden === "boolean") &&
    (value.visibility_only === undefined || typeof value.visibility_only === "boolean")
  );
}
export async function listProviderModels(
  filters: { tenant?: string; provider?: string; offset?: number } = {},
  signal?: AbortSignal
): Promise<ProviderModelPage> {
  const query = new URLSearchParams({ limit: "50", offset: String(filters.offset ?? 0) });
  if (filters.tenant) query.set("tenant_id", filters.tenant);
  if (filters.provider) query.set("provider", filters.provider);
  const value = await request(`/api/admin/provider-models?${query}`, { signal });
  if (
    !record(value) ||
    !Array.isArray(value.models) ||
    !value.models.every(model) ||
    ![value.total, value.offset, value.limit].every(
      (number) => Number.isSafeInteger(number) && (number as number) >= 0
    )
  ) {
    throw new Error("Invalid custom model response");
  }
  return value as unknown as ProviderModelPage;
}
export async function saveProviderModel(
  input: ProviderModelInput,
  id?: string
): Promise<ProviderModel> {
  const value = await request(
    `/api/admin/provider-models${id ? `/${encodeURIComponent(id)}` : ""}`,
    {
      method: id ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }
  );
  if (!record(value) || !model(value.model)) throw new Error("Invalid custom model response");
  return value.model;
}
export async function deleteProviderModel(model: ProviderModel): Promise<void> {
  const query = new URLSearchParams({ revision: model.revision });
  const value = await request(
    `/api/admin/provider-models/${encodeURIComponent(model.id)}?${query}`,
    { method: "DELETE" }
  );
  if (!record(value) || value.deleted !== true)
    throw new Error("Custom model removal was not confirmed");
}

export async function readProviderModel(id: string): Promise<ProviderModel> {
  const value = await request(`/api/admin/provider-models/${encodeURIComponent(id)}`);
  if (!record(value) || !model(value.model)) throw new Error("Invalid custom model response");
  return value.model;
}
