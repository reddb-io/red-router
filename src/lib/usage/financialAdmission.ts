import { randomUUID } from "node:crypto";
import { checkBudget } from "@/domain/costRules";
import { getBudgetReservationScopes } from "@/domain/budgetEngine";
import { releaseBudgetCost } from "@/lib/db/budgetReservations";
import { getPricingForModel } from "@/lib/db/settings/pricing";
import { logger } from "@/shared/utils/logger";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import {
  consumesMeteredBudget,
  rejectIfMeteredBudgetExceeded,
  type BudgetActor,
} from "./meteredBudgetPolicy";

/** Estimated admission, not a guarantee of the final upstream bill. */
export async function beginFinancialRequest(
  actor: BudgetActor,
  provider: string,
  model: string,
  body: Record<string, unknown>
) {
  const keyId = typeof actor === "string" ? actor : actor?.id;
  let id: string | null = null;
  try {
    const attribution = typeof actor === "object" ? actor?.attribution : null;
    const hasCap =
      keyId &&
      consumesMeteredBudget(provider) &&
      (checkBudget(keyId).activeLimitUsd > 0 ||
        getBudgetReservationScopes({ keyId, provider, model, ...attribution }).length > 0);
    let usd = 0;
    if (hasCap) {
      const pricing = await getPricingForModel(provider, model);
      if (
        !pricing ||
        !Number.isFinite(Number(pricing.input)) ||
        !Number.isFinite(Number(pricing.output))
      )
        return {
          id: null,
          error: errorResponse(503, "A catalog price is required for budget admission", {
            code: "BUDGET_PRICE_UNAVAILABLE",
          }),
        };
      const inputTokens = Buffer.byteLength(JSON.stringify(body), "utf8");
      const requestedOutput = Number(body.max_completion_tokens ?? body.max_tokens ?? 4096);
      const outputTokens =
        Number.isFinite(requestedOutput) && requestedOutput > 0 ? requestedOutput : 4096;
      usd =
        (inputTokens * Math.max(0, Number(pricing.input)) +
          outputTokens * Math.max(0, Number(pricing.output))) /
        1_000_000;
      id = randomUUID();
    }
    const error = await rejectIfMeteredBudgetExceeded(
      actor,
      provider,
      model,
      id ? { id, usd } : undefined
    );
    return { id: error ? null : id, error };
  } catch (error) {
    logger.error({ err: error, module: "financial-admission" }, "Budget admission unavailable");
    return {
      id: null,
      error: errorResponse(503, "Budget admission unavailable", { code: "BUDGET_UNAVAILABLE" }),
    };
  }
}

export function finishFinancialRequest(id: string | null): void {
  if (!id) return;
  try {
    releaseBudgetCost(id);
  } catch (error) {
    logger.error(
      { err: error, module: "financial-admission" },
      "Budget reservation retained until expiry"
    );
  }
}

export async function withFinancialRequest(
  actor: BudgetActor,
  provider: string,
  model: string,
  body: Record<string, unknown>,
  dispatch: () => Promise<Response>
): Promise<Response> {
  const admission = await beginFinancialRequest(actor, provider, model, body);
  if (admission.error) return admission.error;
  try {
    const response = await dispatch();
    if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
      finishFinancialRequest(admission.id);
      return response;
    }
    const reader = response.body.getReader();
    const stream = new ReadableStream({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) {
            finishFinancialRequest(admission.id);
            controller.close();
          } else controller.enqueue(next.value);
        } catch (error) {
          finishFinancialRequest(admission.id);
          controller.error(error);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          finishFinancialRequest(admission.id);
        }
      },
    });
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    finishFinancialRequest(admission.id);
    throw error;
  }
}
