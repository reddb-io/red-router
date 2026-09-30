import { BaseGuardrail, type GuardrailContext, type GuardrailResult } from "./base";
import {
  CONTENT_FILTER_REQUEST_BLOCK_MESSAGE,
  CONTENT_FILTER_RESPONSE_BLOCK_MESSAGE,
  compileContentFilterRules,
  extractScanTexts,
  findMatchingRules,
  type CompiledContentRule,
  type ContentFilterConfig,
} from "./contentFilterRules";

export const CONTENT_FILTER_GUARDRAIL_ID = "content-filter";

// The plan object is rebuilt per request from a cached settings read, but its `contentFilter`
// config is the same object between reads, so compile once per config object.
const compiledCache = new WeakMap<ContentFilterConfig, CompiledContentRule[]>();

function compiledRules(config: ContentFilterConfig): CompiledContentRule[] {
  let compiled = compiledCache.get(config);
  if (!compiled) {
    compiled = compileContentFilterRules(config.rules);
    compiledCache.set(config, compiled);
  }
  return compiled;
}

/**
 * Operator-defined blocked keywords and patterns. Off unless the plan carries an enabled
 * content-filter setting. A `block` rule rejects the request or response with a fixed message
 * (never the rule or the matched text); a `flag` rule lets it through and records an event.
 * Streaming responses are not post-call scanned: the response side only sees complete
 * non-streaming bodies.
 */
export class ContentFilterGuardrail extends BaseGuardrail {
  // Operator policy: a caller's opt-out header or body field must not switch it off.
  honorsCallerOptOut = false;

  constructor(options: { enabled?: boolean; priority?: number } = {}) {
    super(CONTENT_FILTER_GUARDRAIL_ID, { enabled: options.enabled, priority: options.priority ?? 8 });
  }

  override isActive(context: GuardrailContext): boolean {
    return Boolean(context.guardrailPlan?.contentFilter?.enabled);
  }

  private evaluate(
    payload: unknown,
    context: GuardrailContext,
    stage: "request" | "response"
  ): GuardrailResult<unknown> {
    const config = context.guardrailPlan?.contentFilter;
    if (!config?.enabled) return { block: false };

    const matches = findMatchingRules(extractScanTexts(payload), compiledRules(config), stage);
    if (matches.length === 0) return { block: false };

    const blocking = matches.find((rule) => rule.action === "block");
    for (const rule of matches) {
      if (rule.action !== "flag" || rule === blocking) continue;
      try {
        context.recordEvent?.({
          guardrailId: CONTENT_FILTER_GUARDRAIL_ID,
          stage,
          action: "flag",
          ruleId: rule.id,
        });
      } catch {
        // Monitoring must never affect the request.
      }
    }

    if (blocking) {
      return {
        block: true,
        message:
          stage === "request"
            ? CONTENT_FILTER_REQUEST_BLOCK_MESSAGE
            : CONTENT_FILTER_RESPONSE_BLOCK_MESSAGE,
        meta: { ruleId: blocking.id, action: "block" },
      };
    }
    const flagged = matches.filter((rule) => rule.action === "flag");
    return { block: false, meta: { flagged: true, ruleIds: flagged.map((rule) => rule.id) } };
  }

  async preCall(payload: unknown, context: GuardrailContext): Promise<GuardrailResult<unknown>> {
    return this.evaluate(payload, context, "request");
  }

  async postCall(response: unknown, context: GuardrailContext): Promise<GuardrailResult<unknown>> {
    return this.evaluate(response, context, "response");
  }
}
