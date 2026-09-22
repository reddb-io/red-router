// Which model served a successful response and what it cost, for clients that
// track spend per turn. Every helper fails open: a missing price, an unreadable
// usage object or a pricing lookup error drops the cost, never the response.

import { canonicalizeUsage } from "./usageTracking.js";
import { calculateCostFromTokens } from "../providers/pricing.js";
import { COST_HEADER } from "../config/runtimeConfig.js";

// "model(high)" -> "model"; same rule as translator/concerns/thinkingUnified.js,
// inlined so this module stays free of the provider registry.
const stripThinkingSuffix = (id) => id.replace(/\([^()]+\)\s*$/, "").trim();

// Terminal Responses API events whose `response.usage` is the turn's final usage.
const RESPONSES_TERMINAL_EVENTS = new Set(["response.completed", "response.incomplete", "response.done"]);

/**
 * The id that answered, as the client or combo addressed it (so it matches
 * /v1/models and the combo's member list), without a thinking suffix. Bare
 * aliases have no provider prefix, so they report the resolved provider/model.
 */
export function servedModelId(modelStr, provider, model) {
  const addressed = typeof modelStr === "string" ? stripThinkingSuffix(modelStr.trim()) : "";
  if (addressed.includes("/")) return addressed;
  return `${provider}/${stripThinkingSuffix(String(model ?? ""))}`;
}

/** Price for provider/model with the operator's overrides (same lookup the usage DB uses), or null. */
export async function resolvePricing(provider, model) {
  try {
    const { getPricingForModel } = await import("@/lib/db/repos/pricingRepo.js");
    return (await getPricingForModel(provider, model)) || null;
  } catch {
    return null;
  }
}

/** USD cost of a usage object in any client format, or null when it cannot be priced. */
export function costFromUsage(usage, pricing) {
  if (!pricing) return null;
  const tokens = canonicalizeUsage(usage);
  if (!tokens) return null;
  const cost = calculateCostFromTokens(tokens, pricing);
  return Number.isFinite(cost) && cost >= 0 ? Math.round(cost * 1e10) / 1e10 : null;
}

/** Plain decimal (never exponent notation), trailing zeros trimmed. */
export function formatCostHeader(cost) {
  return cost.toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
}

/** `{ [COST_HEADER]: "…" }` for a non-streaming response, or `{}` when the cost is unknown. */
export async function costHeaders(provider, model, usage) {
  if (!usage || typeof usage !== "object") return {};
  const cost = costFromUsage(usage, await resolvePricing(provider, model));
  return cost === null ? {} : { [COST_HEADER]: formatCostHeader(cost) };
}

/**
 * Rewrites a client-format SSE stream so the event carrying the turn's final usage
 * also carries `usage.cost` (USD): the OpenAI chat chunk with `usage`, the Anthropic
 * `message_delta`, and the terminal Responses event's `response.usage`. The cost is
 * priced from `currentUsage()` (the upstream usage the stream tracked, which is what
 * the usage DB records) and falls back to the event's own usage. When several events
 * carry usage, the last one is authoritative.
 *
 * @param {object} options
 * @param {Promise<object|null>} options.pricing - resolved pricing for the served model
 * @param {() => object|null} [options.currentUsage] - latest upstream usage seen by the stream
 */
export function createUsageCostStream({ pricing, currentUsage = null }) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  const rewrite = async (line) => {
    // Cheap filter first: only a data line that mentions usage can need a cost.
    if (!line.startsWith("data:") || !line.includes("\"usage\"")) return line;
    try {
      const payload = JSON.parse(line.slice(5));
      const usage = finalUsageObject(payload);
      if (!usage) return line;
      const cost = costFromUsage(currentUsage?.() || usage, await pricing);
      if (cost === null) return line;
      usage.cost = cost;
      return `data: ${JSON.stringify(payload)}${line.endsWith("\r") ? "\r" : ""}`;
    } catch {
      return line;
    }
  };

  return new TransformStream({
    async transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      if (lines.length === 0) return;
      const out = [];
      for (const line of lines) out.push(await rewrite(line));
      controller.enqueue(encoder.encode(`${out.join("\n")}\n`));
    },
    async flush(controller) {
      buffer += decoder.decode();
      if (buffer) controller.enqueue(encoder.encode(await rewrite(buffer)));
    },
  });
}

function finalUsageObject(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.type === "message_delta") return plainObject(payload.usage);
  if (RESPONSES_TERMINAL_EVENTS.has(payload.type)) return plainObject(payload.response?.usage);
  if (payload.object === "chat.completion.chunk" || Array.isArray(payload.choices)) return plainObject(payload.usage);
  return null;
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
