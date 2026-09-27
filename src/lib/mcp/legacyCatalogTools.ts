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
type CatalogModel = z.infer<typeof modelSchema>;

export type LegacyCatalogLoader = (context: LegacyMcpContext) => Promise<CatalogModel[]>;

export function parseLegacyKeyCatalog(body: unknown): CatalogModel[] {
  const parsed = catalogSchema.safeParse(body);
  if (!parsed.success) {
    throw new LegacyMcpToolError("catalog_unavailable", "Model catalog unavailable");
  }
  // The old tools described LLMs, not the newer embedding/media endpoints.
  return parsed.data.data.filter(
    (model) =>
      !["embedding", "image", "rerank", "audio", "moderation", "video", "music"].includes(
        model.type ?? ""
      )
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

export function createLegacyCatalogTools(load: LegacyCatalogLoader): LegacyMcpTool[] {
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
          models: found.slice(0, limit).map((model) => summary(model)),
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
        return { id_format: "catalog", model: summary(entry, true) };
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
        const combos = (await load(context)).filter((model) => model.owned_by === "combo");
        return { total: combos.length, combos: combos.map((model) => summary(model)) };
      },
    },
  ];
}
