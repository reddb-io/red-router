import { createHash } from "node:crypto";
import { z } from "zod";
import { getModelEndpointDecision } from "@omniroute/open-sse/services/modelEndpointPolicy";

import {
  INTERNAL_MODELS_FETCH_HEADER,
  RED_ROUTER_DEFAULT_BASE_URL,
  redRouterEndpoint,
} from "@omniroute/open-sse/config/redRouter";

const connectionSchema = z.object({
  id: z.string().min(1),
  provider: z.literal("red-router"),
  apiKey: z.string().trim().min(1),
  providerSpecificData: z.record(z.string(), z.unknown()).nullish(),
});

const modelSchema = z.object({
  id: z.string().trim().min(1).max(2048),
  name: z.string().max(4096).optional(),
  owned_by: z.string().optional(),
  type: z.string().optional(),
  supported_endpoints: z.array(z.string().max(100)).max(20).optional(),
  provider: z.object({ id: z.string().optional(), via: z.string().optional() }).optional(),
  context_length: z.number().positive().finite().optional(),
  max_output_tokens: z.number().positive().finite().optional(),
  capabilities: z
    .object({
      tools: z.boolean().optional(),
      tool_calling: z.boolean().optional(),
      vision: z.boolean().optional(),
      reasoning: z.boolean().optional(),
      decision: z.boolean().optional(),
      chat: z.boolean().optional(),
      thinking: z.boolean().optional(),
      supportsThinking: z.boolean().optional(),
      structured_output: z.boolean().optional(),
      effort_tiers: z.array(z.string().max(100)).max(20).optional(),
    })
    .optional(),
  input_modalities: z.array(z.string()).optional(),
});
export type RemoteRouterModel = z.infer<typeof modelSchema>;
export interface RemoteRouterSnapshot {
  id: string;
  apiKey: string;
  url: string;
  fingerprint: string;
  autoFetch: boolean;
}
export interface RemoteRouterCache {
  fingerprint: string;
  syncedAt: number;
  models: RemoteRouterModel[];
}
export interface RemoteRouterDiscoveryDependencies {
  read(snapshot: RemoteRouterSnapshot): RemoteRouterCache | null;
  commit(snapshot: RemoteRouterSnapshot, cache: RemoteRouterCache): boolean;
  fetch(url: string, init: RequestInit, connectionId: string): Promise<Response>;
  now?: () => number;
}
export class RemoteRouterDiscoveryError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export function remoteRouterSnapshot(connection: unknown): RemoteRouterSnapshot {
  const parsed = connectionSchema.parse(connection);
  const data = parsed.providerSpecificData ?? {};
  if (data.connectionProxyEnabled === true || data.vercelRelayUrl) {
    throw new Error("Legacy remote router proxy settings require migration");
  }
  const configuredUrl = data.baseUrl ?? RED_ROUTER_DEFAULT_BASE_URL;
  if (typeof configuredUrl !== "string") throw new Error("Invalid remote router URL");
  const url = redRouterEndpoint(configuredUrl, "models");
  return {
    id: parsed.id,
    apiKey: parsed.apiKey,
    url,
    fingerprint: createHash("sha256")
      .update(JSON.stringify([url, parsed.apiKey]))
      .digest("hex"),
    autoFetch: data.autoFetchModels !== false,
  };
}

/** Preserve remote IDs verbatim. Each receiving router adds one public `red/` hop. */
export function isRemoteDecisionModel(model: RemoteRouterModel): boolean {
  return (
    model.type === "systemone" ||
    model.capabilities?.decision === true ||
    model.supported_endpoints?.some((endpoint) =>
      ["systemone", "decisions"].includes(endpoint.replace(/^\/?(?:v1\/)?/, ""))
    ) === true
  );
}

/** Bound federation chains so cyclic connection graphs cannot grow catalogs forever. */
export function parseRemoteRouterModels(body: unknown): RemoteRouterModel[] {
  const envelope = z
    .union([
      z.array(z.unknown()),
      z.object({ data: z.array(z.unknown()) }),
      z.object({ models: z.array(z.unknown()) }),
    ])
    .parse(body);
  const rows = Array.isArray(envelope)
    ? envelope
    : "data" in envelope
      ? envelope.data
      : envelope.models;
  if (rows.length > 10_000) throw new Error("Remote catalog too large");
  const models = new Map<string, RemoteRouterModel>();
  for (const row of rows) {
    // Malformed data is not an authoritative empty list: keep the last good cache.
    const model = modelSchema.parse(row);
    const decision = isRemoteDecisionModel(model);
    if (!decision && model.type && !["llm", "chat", "imageToText"].includes(model.type)) continue;
    const hops = model.id
      .split("/")
      .filter((part) => ["red", "red-router", "redrouter"].includes(part)).length;
    if (hops >= 8) continue;
    models.set(model.id, model);
  }
  return [...models.values()];
}

async function readCatalog(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Missing remote catalog");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4 * 1024 * 1024) {
        await reader.cancel();
        throw new Error("Remote catalog too large");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    reader.releaseLock();
  }
}

export function createRemoteRouterCatalogSync(deps: RemoteRouterDiscoveryDependencies) {
  const inFlight = new Map<
    string,
    Promise<{ models: RemoteRouterModel[]; source: "api" | "cache"; warning?: string }>
  >();
  return async (connection: unknown, force = false) => {
    let snapshot: RemoteRouterSnapshot;
    try {
      snapshot = remoteRouterSnapshot(connection);
    } catch {
      throw new RemoteRouterDiscoveryError(400, "Invalid remote router connection");
    }
    const now = deps.now ?? Date.now;
    const stored = deps.read(snapshot);
    const cached = stored?.fingerprint === snapshot.fingerprint ? stored : null;
    const age = cached ? now() - cached.syncedAt : Infinity;
    if (!force && (!snapshot.autoFetch || (age >= 0 && age < 5 * 60 * 1000))) {
      return { models: cached?.models ?? [], source: "cache" as const };
    }
    const key = `${snapshot.id}:${snapshot.fingerprint}`;
    const pending = inFlight.get(key);
    if (pending) return pending;
    const task = (async () => {
      try {
        const response = await deps.fetch(
          snapshot.url,
          {
            method: "GET",
            cache: "no-store",
            redirect: "error",
            headers: {
              Authorization: `Bearer ${snapshot.apiKey}`,
              [INTERNAL_MODELS_FETCH_HEADER]: "1",
            },
            signal: AbortSignal.timeout(8000),
          },
          snapshot.id
        );
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status === 401 || response.status === 403) {
            throw new RemoteRouterDiscoveryError(
              502,
              "Remote router rejected its configured credential"
            );
          }
          throw new Error("Remote catalog unavailable");
        }
        const body = await readCatalog(response);
        // A paged response cannot replace a full saved catalog.
        if (body && typeof body === "object" && "has_more" in body && body.has_more === true) {
          throw new Error("Incomplete remote catalog");
        }
        const models = parseRemoteRouterModels(body);
        if (
          !deps.commit(snapshot, { fingerprint: snapshot.fingerprint, syncedAt: now(), models })
        ) {
          throw new RemoteRouterDiscoveryError(
            409,
            "Remote router connection changed during discovery; retry"
          );
        }
        return { models, source: "api" as const };
      } catch (error) {
        if (error instanceof RemoteRouterDiscoveryError) throw error;
        const fallback = deps.read(snapshot);
        if (fallback?.fingerprint === snapshot.fingerprint)
          return {
            models: fallback.models,
            source: "cache" as const,
            warning: "Remote router unavailable; using this credential's saved catalog",
          };
        throw new RemoteRouterDiscoveryError(502, "Remote router catalog unavailable");
      }
    })();
    inFlight.set(key, task);
    try {
      return await task;
    } finally {
      inFlight.delete(key);
    }
  };
}
