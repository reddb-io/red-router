import { createHash } from "node:crypto";

import { z } from "zod";

import { buildQoderCnCosyHeaders } from "./qoderCnCosy.ts";
import { QoderCnHttpError } from "./qoderCnHttpError.ts";
import { resolveQoderCnPat } from "./qoderCnPat.ts";

const MODEL_LIST_URL = "https://gateway.qoder.com.cn/algo/api/v2/model/list";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 128;

const ModelConfigSchema = z
  .object({
    key: z.string().min(1).max(128),
    display_name: z.string().max(256).optional(),
    enable: z.boolean().optional(),
    max_input_tokens: z.number().nonnegative().optional(),
    max_output_tokens: z.number().nonnegative().optional(),
    is_vl: z.boolean().optional(),
    is_reasoning: z.boolean().optional(),
  })
  .passthrough();
const CatalogResponseSchema = z.object({ chat: z.array(ModelConfigSchema).max(256) });

export type QoderCnCatalogModel = {
  id: string;
  name: string;
  contextLength: number;
  maxOutputTokens: number;
  supportsVision: boolean;
  supportsReasoning: boolean;
  hidden: boolean;
};

export type QoderCnCatalog = {
  models: QoderCnCatalogModel[];
  rawConfigs: Map<string, z.infer<typeof ModelConfigSchema>>;
  expiresAt: number;
};

export type QoderCnCatalogCredential = {
  token: string;
  userId?: string;
  machineId?: string;
  name?: string;
  email?: string;
};

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
type CatalogOptions = {
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  forceRefresh?: boolean;
};

const cache = new Map<string, QoderCnCatalog>();
const pending = new Map<string, Promise<QoderCnCatalog>>();

async function readBoundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Qoder CN model list returned an empty body");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel("Qoder CN model list exceeded limit");
        throw new Error("Qoder CN model list exceeded limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new Error("Qoder CN model list returned invalid JSON");
  }
}

function awaitCaller<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new Error("Aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

async function fetchCatalog(
  token: string,
  userId: string,
  credential: QoderCnCatalogCredential,
  fetchImpl: FetchLike
): Promise<QoderCnCatalog> {
  const headers = buildQoderCnCosyHeaders(new Uint8Array(), MODEL_LIST_URL, {
    authToken: token,
    userId,
    machineId: credential.machineId || undefined,
    name: credential.name,
    email: credential.email,
  });
  const response = await fetchImpl(MODEL_LIST_URL, {
    method: "GET",
    headers: { Accept: "application/json", "Accept-Encoding": "identity", ...headers },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new QoderCnHttpError("model list", response.status);
  }
  const parsed = CatalogResponseSchema.safeParse(await readBoundedJson(response));
  if (!parsed.success) throw new Error("Qoder CN model list has an invalid shape");

  const models: QoderCnCatalogModel[] = [];
  const rawConfigs = new Map<string, z.infer<typeof ModelConfigSchema>>();
  for (const config of parsed.data.chat) {
    if (rawConfigs.has(config.key)) throw new Error("Qoder CN model list has duplicate keys");
    rawConfigs.set(config.key, config);
    models.push({
      id: config.key,
      name: config.display_name || config.key,
      contextLength: config.max_input_tokens || 131_072,
      maxOutputTokens: config.max_output_tokens || 0,
      supportsVision: config.is_vl === true,
      supportsReasoning: config.is_reasoning === true,
      hidden: config.enable === false,
    });
  }
  if (models.length === 0) throw new Error("Qoder CN model list is empty");
  return { models, rawConfigs, expiresAt: Date.now() + CACHE_TTL_MS };
}

/** Retrieve the account-specific CN catalog; never substitute static/global model configs. */
export async function resolveQoderCnModels(
  credential: QoderCnCatalogCredential,
  options: CatalogOptions = {}
): Promise<QoderCnCatalog> {
  if (options.signal?.aborted) throw options.signal.reason ?? new Error("Aborted");
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const rawToken = credential.token.trim();
  const resolved = rawToken.startsWith("pt-")
    ? await resolveQoderCnPat(rawToken, { fetchImpl, signal: options.signal })
    : { accessToken: rawToken, userId: credential.userId || "" };
  if (!resolved.userId) throw new Error("Qoder CN model list requires a user ID");

  const key = createHash("sha256")
    .update(`qoder-cn\0${resolved.userId}\0${resolved.accessToken}`)
    .digest("hex");
  const cached = cache.get(key);
  if (!options.forceRefresh && cached && cached.expiresAt > Date.now()) return cached;

  let inFlight = pending.get(key);
  if (!inFlight) {
    inFlight = fetchCatalog(resolved.accessToken, resolved.userId, credential, fetchImpl)
      .then((catalog) => {
        for (const [candidate, value] of cache) {
          if (value.expiresAt <= Date.now()) cache.delete(candidate);
        }
        if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
        cache.set(key, catalog);
        return catalog;
      })
      .finally(() => {
        pending.delete(key);
      });
    pending.set(key, inFlight);
  }
  return awaitCaller(inFlight, options.signal);
}

/** Return the exact upstream block, or fail instead of silently downgrading models. */
export async function getQoderCnModelConfig(
  credential: QoderCnCatalogCredential,
  modelKey: string,
  options: CatalogOptions = {}
): Promise<z.infer<typeof ModelConfigSchema>> {
  if (!modelKey || modelKey.length > 128) throw new Error("Qoder CN model key is invalid");
  let catalog = await resolveQoderCnModels(credential, options);
  let config = catalog.rawConfigs.get(modelKey);
  if (!config && !options.forceRefresh) {
    catalog = await resolveQoderCnModels(credential, { ...options, forceRefresh: true });
    config = catalog.rawConfigs.get(modelKey);
  }
  if (!config) throw new Error("Qoder CN model config is unavailable");
  return { ...config };
}

export function clearQoderCnModelCacheForTest(): void {
  cache.clear();
  pending.clear();
}
