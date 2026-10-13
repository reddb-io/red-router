import { calculateCost } from "@/lib/usage/costCalculator";
import { recordChatCallCost } from "@/domain/costRules";
import { logger } from "@/shared/utils/logger";

/** Record measured embedding usage through the same durable ledger as chat. */
export async function recordEmbeddingUsage(input: {
  apiKeyId?: string | null;
  provider: string;
  model: string;
  usage: Record<string, number> | null;
  requestId: string;
}): Promise<number> {
  const tokens = {
    ...input.usage,
    prompt_tokens: input.usage?.prompt_tokens ?? input.usage?.total_tokens ?? 0,
    completion_tokens: 0,
  };
  let amount = 0;
  try {
    amount = input.usage ? await calculateCost(input.provider, input.model, tokens) : 0;
  } catch (error) {
    logger.error(
      { err: error, module: "embedding-usage" },
      "Pricing unavailable; retaining measured usage"
    );
  }
  const cost = Number.isFinite(amount) ? Math.max(0, amount) : 0;
  recordChatCallCost(
    { id: input.apiKeyId },
    cost,
    {
      provider: input.provider,
      model: input.model,
      tokens,
      requestId: input.requestId,
    },
    true
  );
  return cost;
}
