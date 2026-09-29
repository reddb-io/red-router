import { z } from "zod";

import { errorResponse } from "../utils/error";
import { computeCatalogVersion } from "@/lib/catalogVersion";
import { RED_ROUTER_CATALOG_VERSION_HEADER } from "@/shared/constants/redRouterHeaders";

export interface DiscoveryKey {
  id: string;
  name: string;
  role: "admin" | "standard";
  idFormat: "prefixed" | "flat";
  persisted: boolean;
}

export interface DiscoveryDependencies {
  authenticate(token: string): Promise<DiscoveryKey | null>;
  catalog(request: Request): Promise<Response>;
  version: string;
  mcpSchemaVersion: number;
  strategies: readonly string[];
  decision: { header: string; hintHeader: string; hintKeys: readonly string[] };
}

const querySchema = z
  .object({
    for: z.string().max(128).optional(),
    // The integrated catalog emits expanded IDs. Do not silently promise the
    // baseline's collapsed variant contract until it is implemented.
    variants: z.literal("expand").optional(),
  })
  .strict();

const modelSchema = z
  .object({
    id: z.string().min(1),
    owned_by: z.string().optional(),
    type: z.string().optional(),
    created: z.number().optional(),
  })
  .passthrough();
const catalogSchema = z.object({ data: z.array(modelSchema) });
type Model = z.infer<typeof modelSchema>;

function privateHeaders(source?: HeadersInit): Headers {
  const headers = new Headers(source);
  headers.set("Cache-Control", "private, no-store");
  const vary = new Set(
    (headers.get("Vary") ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
  );
  vary.add("Authorization");
  vary.add("x-api-key");
  vary.add("x-goog-api-key");
  headers.set("Vary", [...vary].join(", "));
  return headers;
}

function privateResponse(response: Response): Response {
  return new Response(response.body, {
    status: response.status,
    headers: privateHeaders(response.headers),
  });
}

function invalidKey(): Response {
  const response = errorResponse(401, "Invalid API key", {
    code: "invalid_api_key",
    type: "invalid_api_key",
  });
  response.headers.set("WWW-Authenticate", 'Bearer realm="red-router"');
  return privateResponse(response);
}

/** Only explicit header credentials; discovery never accepts secrets in URLs. */
function credential(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization !== null) {
    return /^Bearer\s+(\S+)$/i.exec(authorization.trim())?.[1] ?? "";
  }
  for (const name of ["x-api-key", "x-goog-api-key"]) {
    if (request.headers.has(name)) return request.headers.get(name)!.trim();
  }
  return null;
}

export async function handleKeyDiscovery(
  request: Request,
  deps: DiscoveryDependencies
): Promise<Response> {
  try {
    const token = credential(request);
    const key = token ? await deps.authenticate(token) : null;
    // Match /v1/mcp: environment keys have no persisted tenant identity.
    if (!key?.persisted) return invalidKey();
    return Response.json(
      {
        object: "api_key",
        id: key.id,
        name: key.name,
        role: key.role,
        id_format: key.idFormat,
        mcp: {
          url: new URL("/v1/mcp", request.url).href,
          transport: "streamable-http",
          schema_version: deps.mcpSchemaVersion,
          admin_tools: key.role === "admin",
          local_only: true,
        },
      },
      { headers: privateHeaders() }
    );
  } catch {
    return privateResponse(errorResponse(500, "Key discovery unavailable"));
  }
}

function groupedCatalog(models: Model[]) {
  const groups = new Map<string, { provider: { id: string }; models: Model[] }>();
  const combos: Model[] = [];
  const aliases: Model[] = [];
  for (const model of models) {
    if (model.owned_by === "combo") {
      combos.push(model);
      continue;
    }
    if (model.owned_by === "alias") {
      aliases.push(model);
      continue;
    }
    const id = model.owned_by ?? "unknown";
    if (!groups.has(id)) groups.set(id, { provider: { id }, models: [] });
    groups.get(id)!.models.push(model);
  }
  return { groups: [...groups.values()], combos, aliases, recommended: {} };
}

function catalogVersion(models: Model[]): string {
  return computeCatalogVersion(models);
}

/** These documents are projections of the authorized catalog, never the registry. */
export async function handleCatalogDiscovery(
  request: Request,
  deps: DiscoveryDependencies,
  kind: "catalog" | "capabilities"
): Promise<Response> {
  try {
    const token = credential(request);
    if (token !== null && (!token || !(await deps.authenticate(token)))) return invalidKey();
    const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!query.success) {
      return privateResponse(
        errorResponse(
          400,
          "Unsupported discovery query; only for and variants=expand are supported"
        )
      );
    }
    const url = new URL(request.url);
    url.pathname = "/api/v1/models";
    url.search = ""; // Always the full scoped catalog, never a page or client filter.
    const headers = new Headers(request.headers);
    // The unified catalog's x-api-key support is Anthropic-specific. Normalize
    // a validated discovery credential to preserve the same key's visibility.
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const source = await deps.catalog(new Request(url, { headers, signal: request.signal }));
    if (!source.ok) return privateResponse(source);
    const models = catalogSchema.parse(await source.json()).data;
    const version = catalogVersion(models);
    const systemOneModels = models.filter((model) => model.type === "systemone");
    const body =
      kind === "catalog"
        ? {
            version,
            ...groupedCatalog(models),
            compatibility: { baseline: "v0.33.0", complete: false },
          }
        : {
            product: "red-router",
            version: deps.version,
            systemone: {
              endpoint: "/v1/systemone",
              aliases: ["/v1/decisions"],
              models: systemOneModels.map((model) => model.id),
              // RedCode gates System One on this flag: true when the key's scoped catalog
              // lists at least one System One model, i.e. the key can reach it.
              available: systemOneModels.length > 0,
              // Catalog membership is not a successful credential/health probe.
              availability: "not_probed",
            },
            combos: { strategies: [...deps.strategies] },
            decision: {
              scope: "combo",
              header: deps.decision.header,
              accepts_hint: true,
              hint_header: deps.decision.hintHeader,
              hint_keys: [...deps.decision.hintKeys],
            },
            catalog: {
              version,
              catalog_endpoint: "/v1/catalog",
              model_endpoint: "/v1/models/info?id={id}",
              variants: "expand",
              recommendations: false,
              account_metadata: false,
              key_id_format_applied: false,
            },
            compatibility: { baseline: "v0.33.0", complete: false },
          };
    const responseHeaders = privateHeaders(source.headers);
    responseHeaders.set("Content-Type", "application/json");
    responseHeaders.set(RED_ROUTER_CATALOG_VERSION_HEADER, version);
    for (const header of ["content-length", "content-encoding", "etag", "last-modified"]) {
      responseHeaders.delete(header);
    }
    return Response.json(body, { headers: responseHeaders });
  } catch {
    return privateResponse(errorResponse(500, "Client discovery unavailable"));
  }
}
