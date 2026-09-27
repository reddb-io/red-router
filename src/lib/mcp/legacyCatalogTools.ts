import { z } from "zod";

import { LegacyMcpToolError, type LegacyMcpContext, type LegacyMcpTool } from "./legacyProtocol";

const capabilityNames = [
  "vision",
  "tools",
  "reasoning",
  "pdf",
  "search",
  "imageOutput",
  "audioInput",
  "audioOutput",
  "videoInput",
] as const;
const capabilitySchema = z.enum(capabilityNames);
const modelSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    owned_by: z.string().optional(),
    type: z.string().optional(),
    context_length: z.number().optional(),
    max_output_tokens: z.number().optional(),
    capabilities: z.record(z.string(), z.unknown()).optional(),
    pricing: z.record(z.string(), z.unknown()).optional(),
    strategy: z.string().optional(),
    members: z.array(z.string()).optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    input_modalities: z.array(z.string()).optional(),
    output_modalities: z.array(z.string()).optional(),
  })
  .passthrough();
const catalogSchema = z.object({ data: z.array(modelSchema) }).passthrough();
export type CatalogModel = z.infer<typeof modelSchema>;

export type LegacyCatalogLoader = (context: LegacyMcpContext) => Promise<CatalogModel[]>;
export type LegacyCatalogHealth = {
  status: {
    state: "ok" | "quota_exhausted" | "rate_limited" | "unavailable" | "disabled" | "unknown";
    until?: string;
    error_rate?: number;
  };
  usable: boolean | null;
};
export type LegacyCatalogHealthLoader = (
  context: LegacyMcpContext,
  models: CatalogModel[]
) => Promise<Record<string, LegacyCatalogHealth>>;

export function parseLegacyKeyCatalog(body: unknown): CatalogModel[] {
  const parsed = catalogSchema.safeParse(body);
  if (!parsed.success) {
    throw new LegacyMcpToolError("catalog_unavailable", "Model catalog unavailable");
  }
  // The old tools described chat LLMs, not typed Decisions, web or media endpoints.
  return parsed.data.data.filter(
    (model) =>
      ![
        "embedding",
        "image",
        "rerank",
        "systemone",
        "audio",
        "moderation",
        "video",
        "music",
        "webSearch",
        "webFetch",
      ].includes(model.type ?? "")
  );
}

function summary(model: CatalogModel, detail = false) {
  const capabilities = model.capabilities ?? {};
  const price = model.pricing ?? {};
  const input = typeof price.input === "number" ? price.input : null;
  const output = typeof price.output === "number" ? price.output : null;
  const pricePerMillion = input !== null || output !== null ? { input, output } : null;
  const kind = model.owned_by === "combo" ? "combo" : "model";
  const supported = {
    vision: capabilities.vision === true || model.input_modalities?.includes("image") === true,
    tools: capabilities.tools === true || capabilities.tool_calling === true,
    reasoning: capabilities.reasoning === true || capabilities.supportsThinking === true,
    pdf: capabilities.pdf === true,
    search: capabilities.search === true,
    imageOutput: model.output_modalities?.includes("image") === true,
    audioInput: model.input_modalities?.includes("audio") === true,
    audioOutput: model.output_modalities?.includes("audio") === true,
    videoInput: model.input_modalities?.includes("video") === true,
  };
  // /v1/models does not expose account health. Do not fabricate an "ok" status.
  return {
    id: model.id,
    name: model.name ?? model.id,
    kind,
    provider:
      model.owned_by && kind !== "combo" ? { id: model.owned_by, name: model.owned_by } : null,
    context_length: model.context_length ?? null,
    max_output: model.max_output_tokens ?? null,
    capabilities: capabilityNames.filter((name) => supported[name]),
    thinking_levels: Array.isArray(capabilities.effort_tiers)
      ? capabilities.effort_tiers.filter((tier): tier is string => typeof tier === "string")
      : [],
    strategy: kind === "combo" ? (model.strategy ?? "unknown") : undefined,
    members: kind === "combo" ? (model.members ?? []) : undefined,
    status: { state: "unknown" },
    usable: null,
    price_per_million: pricePerMillion,
    free: pricePerMillion && input === 0 && output === 0 ? true : null,
    ...(detail ? { parameters: model.parameters ?? null } : {}),
  };
}

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const listArgs = z
  .object({
    search: z.string().optional(),
    capability: capabilitySchema.optional(),
    min_context: z.number().int().positive().optional(),
    include_combos: z.boolean().optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict();
const getArgs = z.object({ id: z.string().min(1) }).strict();
const comboArgs = z.object({ include_flat: z.boolean().optional() }).strict();
const recommendArgs = z
  .object({
    needs: z.array(capabilitySchema).optional(),
    current: z.string().min(1).optional(),
    equivalent_to: z.string().min(1).optional(),
    min_context: z.number().int().positive().optional(),
    needs_input_tokens: z.number().int().positive().optional(),
    max_price_per_million: z.number().nonnegative().optional(),
    free_only: z.boolean().optional(),
    prefer: z.enum(["cheapest", "largest_context"]).optional(),
    include_combos: z.boolean().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();

function totalPrice(price: { input: number | null; output: number | null } | null): number | null {
  if (!price || price.input === null || price.output === null) return null;
  return price.input + price.output;
}

function withHealth(
  model: CatalogModel,
  health: Record<string, LegacyCatalogHealth>,
  detail = false
) {
  const base = summary(model, detail);
  const live = health[model.id];
  return { ...base, status: live?.status ?? base.status, usable: live?.usable ?? null };
}

function recommendationDelta(
  base: ReturnType<typeof withHealth>,
  candidate: ReturnType<typeof withHealth>
) {
  const basePrice = totalPrice(base.price_per_million);
  const candidatePrice = totalPrice(candidate.price_per_million);
  return {
    price_delta_pct:
      basePrice !== null && basePrice > 0 && candidatePrice !== null
        ? Math.round(((candidatePrice - basePrice) / basePrice) * 1000) / 10
        : null,
    context_delta: (candidate.context_length ?? 0) - (base.context_length ?? 0),
    gained_capabilities: candidate.capabilities.filter((name) => !base.capabilities.includes(name)),
    lost_capabilities: base.capabilities.filter((name) => !candidate.capabilities.includes(name)),
  };
}

export function createLegacyCatalogTools(
  load: LegacyCatalogLoader,
  loadHealth?: LegacyCatalogHealthLoader
): LegacyMcpTool[] {
  return [
    {
      name: "list_models",
      title: "List models",
      description:
        "Models and combos visible to the calling key; runtime account status is unknown.",
      inputSchema: {
        type: "object",
        properties: {
          search: { type: "string" },
          capability: { type: "string", enum: capabilityNames },
          min_context: { type: "integer", minimum: 1 },
          include_combos: { type: "boolean" },
          limit: { type: "integer", minimum: 1, maximum: 500 },
        },
        additionalProperties: false,
      },
      argsSchema: listArgs,
      annotations: readOnly,
      run: async (rawArgs, context) => {
        const args = listArgs.parse(rawArgs);
        const entries = await load(context);
        const health = loadHealth ? await loadHealth(context, entries) : {};
        const search = args.search?.toLowerCase();
        const found = entries.filter((model) => {
          if (args.include_combos === false && model.owned_by === "combo") return false;
          if (args.min_context && (model.context_length ?? 0) < args.min_context) return false;
          if (args.capability && !summary(model).capabilities.includes(args.capability))
            return false;
          if (
            search &&
            ![model.id, model.name, model.owned_by].some((value) =>
              value?.toLowerCase().includes(search)
            )
          )
            return false;
          return true;
        });
        const limit = args.limit ?? 50;
        return {
          id_format: "catalog",
          total: found.length,
          models: found.slice(0, limit).map((model) => withHealth(model, health)),
          ...(found.length > limit ? { truncated: true } : {}),
        };
      },
    },
    {
      name: "get_model",
      title: "Get model",
      description: "One model or combo visible to the calling key.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      argsSchema: getArgs,
      annotations: readOnly,
      run: async (rawArgs, context) => {
        const { id } = getArgs.parse(rawArgs);
        const entries = await load(context);
        const entry = entries.find((model) => model.id === id);
        if (!entry) throw new LegacyMcpToolError("unknown_model", "Model not found for this key");
        const health = loadHealth ? await loadHealth(context, entries) : {};
        return { id_format: "catalog", model: withHealth(entry, health, true) };
      },
    },
    {
      name: "list_combos",
      title: "List combos",
      description: "Routing combos visible to the calling key.",
      inputSchema: {
        type: "object",
        properties: { include_flat: { type: "boolean" } },
        additionalProperties: false,
      },
      argsSchema: comboArgs,
      annotations: readOnly,
      run: async (_rawArgs, context) => {
        const entries = await load(context);
        const health = loadHealth ? await loadHealth(context, entries) : {};
        const combos = entries.filter((model) => model.owned_by === "combo");
        return { total: combos.length, combos: combos.map((model) => withHealth(model, health)) };
      },
    },
    {
      name: "recommend_models",
      title: "Recommend models",
      description:
        "Rank key-visible, currently usable models by capabilities, context and price. Suggestions only; ask the user before switching.",
      inputSchema: {
        type: "object",
        properties: {
          needs: { type: "array", items: { type: "string", enum: capabilityNames } },
          current: { type: "string" },
          equivalent_to: { type: "string" },
          min_context: { type: "integer", minimum: 1 },
          needs_input_tokens: { type: "integer", minimum: 1 },
          max_price_per_million: { type: "number", minimum: 0 },
          free_only: { type: "boolean" },
          prefer: { type: "string", enum: ["cheapest", "largest_context"] },
          include_combos: { type: "boolean" },
          limit: { type: "integer", minimum: 1, maximum: 50 },
        },
        additionalProperties: false,
      },
      argsSchema: recommendArgs,
      annotations: readOnly,
      run: async (rawArgs, context) => {
        const args = recommendArgs.parse(rawArgs);
        const entries = await load(context);
        const byId = new Map(entries.map((model) => [model.id, model]));
        const find = (id: string | undefined) => {
          if (!id) return null;
          const model = byId.get(id);
          if (!model) throw new LegacyMcpToolError("unknown_model", "Model not found for this key");
          return model;
        };
        const currentModel = find(args.current);
        const referenceModel = find(args.equivalent_to);
        const health = loadHealth ? await loadHealth(context, entries) : {};
        const current = currentModel ? withHealth(currentModel, health) : null;
        const reference = referenceModel ? withHealth(referenceModel, health) : null;
        const needs = [...new Set([...(args.needs ?? []), ...(reference?.capabilities ?? [])])];
        const minContext = Math.max(
          args.min_context ?? 0,
          args.needs_input_tokens ?? 0,
          reference?.context_length ?? 0
        );
        const candidates = entries.filter((model) => {
          if (model.id === current?.id || model.id === reference?.id) return false;
          if (model.owned_by === "alias") return false;
          if (args.include_combos === false && model.owned_by === "combo") return false;
          const candidate = summary(model);
          return (
            (candidate.context_length ?? 0) >= minContext &&
            needs.every((need) => candidate.capabilities.includes(need))
          );
        });
        const prefer = args.prefer ?? "cheapest";
        const scored = candidates
          .map((model) => withHealth(model, health))
          .filter((candidate) => {
            // /v1/models alone is not a live account probe. Unknown is not usable.
            if (candidate.usable !== true) return false;
            const price = totalPrice(candidate.price_per_million);
            if (
              args.max_price_per_million !== undefined &&
              (price === null || price > args.max_price_per_million)
            )
              return false;
            if (args.free_only && candidate.free !== true) return false;
            if (reference && prefer !== "largest_context") {
              const referencePrice = totalPrice(reference.price_per_million);
              const cheaper = referencePrice !== null && price !== null && price < referencePrice;
              const healthier = reference.usable === false && candidate.usable === true;
              if (!cheaper && !healthier) return false;
            }
            return true;
          });
        scored.sort((left, right) => {
          const contextDelta = (right.context_length ?? 0) - (left.context_length ?? 0);
          const leftPrice = totalPrice(left.price_per_million) ?? Infinity;
          const rightPrice = totalPrice(right.price_per_million) ?? Infinity;
          const priceDelta = leftPrice === rightPrice ? 0 : leftPrice - rightPrice;
          return (
            (prefer === "largest_context"
              ? contextDelta || priceDelta
              : priceDelta || contextDelta) || left.id.localeCompare(right.id)
          );
        });
        const base = current ?? reference;
        return {
          id_format: "catalog",
          criteria: {
            needs,
            min_context: minContext || null,
            needs_input_tokens: args.needs_input_tokens ?? null,
            max_price_per_million: args.max_price_per_million ?? null,
            free_only: args.free_only === true,
            prefer,
            current: current?.id ?? null,
            equivalent_to: reference?.id ?? null,
          },
          ...(current ? { current } : {}),
          considered: candidates.length,
          recommendations: scored.slice(0, args.limit ?? 5).map((candidate) => {
            const delta = base ? recommendationDelta(base, candidate) : null;
            const why: Array<{ code: string; detail: string }> = needs.map((need) => ({
              code: need,
              detail: `supports ${need}`,
            }));
            if (candidate.free === true) why.push({ code: "free", detail: "no cost per token" });
            if (delta && delta.price_delta_pct !== null && delta.price_delta_pct < 0) {
              why.push({ code: "cheaper", detail: `${Math.abs(delta.price_delta_pct)}% cheaper` });
            }
            if (delta && delta.context_delta > 0) {
              why.push({
                code: "larger_context",
                detail: `${delta.context_delta} more context tokens`,
              });
            }
            return {
              ...candidate,
              ...(delta ? { delta } : {}),
              why,
              why_text: why.map((item) => item.detail).join("; "),
            };
          }),
          note: "Suggestions only: switch by sending this id as model, after the user agrees.",
        };
      },
    },
  ];
}
