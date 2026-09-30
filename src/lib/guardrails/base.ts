import type { ContentFilterConfig } from "./contentFilterRules";

export interface GuardrailLog {
  debug?: (tag: string, message: string, meta?: Record<string, unknown>) => void;
  info?: (tag: string, message: string, meta?: Record<string, unknown>) => void;
  warn?: (tag: string, message: string, meta?: Record<string, unknown>) => void;
  error?: (tag: string, message: string, meta?: Record<string, unknown>) => void;
}

/** One thing a guardrail did to a request or response, for monitoring. Never carries content. */
export interface GuardrailEventInput {
  guardrailId: string;
  stage: "request" | "response";
  action: "block" | "flag" | "mask";
  /** Id of the operator rule that fired (content filter); never the matched text. */
  ruleId?: string | null;
}

/**
 * What the operator's settings say for one request: per-guardrail on/off and priority overrides
 * (only present once assignments are configured) and the active content-filter rules. Built by
 * `loadGuardrailPlan`; a request without a plan runs exactly as before.
 */
export interface GuardrailPlan {
  entries: Record<string, { enabled: boolean; priority: number }>;
  contentFilter: ContentFilterConfig | null;
}

export interface GuardrailContext {
  apiKeyInfo?: Record<string, unknown> | null;
  disabledGuardrails?: string[] | null;
  endpoint?: string | null;
  guardrailPlan?: GuardrailPlan | null;
  headers?: Headers | Record<string, unknown> | null;
  log?: GuardrailLog | Console | null;
  method?: string | null;
  model?: string | null;
  provider?: string | null;
  /** Fire-and-forget monitoring sink; must never throw into the request. */
  recordEvent?: ((event: GuardrailEventInput) => void) | null;
  /** Caller lifecycle signal; media bridges treat request abort as a deliberate fail-open exception. */
  signal?: AbortSignal;
  sourceFormat?: string | null;
  stream?: boolean;
  targetFormat?: string | null;
}

export interface GuardrailResult<TValue = unknown> {
  block?: boolean;
  message?: string;
  meta?: Record<string, unknown> | null;
  modifiedPayload?: TValue;
  modifiedResponse?: TValue;
}

export interface GuardrailExecutionResult {
  blocked: boolean;
  error?: string;
  guardrail: string;
  message?: string;
  meta?: Record<string, unknown> | null;
  modified: boolean;
  skipped: boolean;
  stage: "pre" | "post";
}

export class BaseGuardrail {
  /**
   * When false the per-call opt-out (`x-omniroute-disabled-guardrails` header or request body)
   * is ignored: operator policy must not be bypassable by the caller. Key-level
   * `disabledGuardrails` and assignments still apply.
   */
  honorsCallerOptOut = true;
  enabled: boolean;
  name: string;
  priority: number;

  constructor(name: string, options: { enabled?: boolean; priority?: number } = {}) {
    this.name = name;
    this.enabled = options.enabled !== false;
    this.priority = options.priority ?? 100;
  }

  /** Return false to keep this guardrail out of the run entirely (no result entry). */
  isActive(_context: GuardrailContext): boolean {
    return true;
  }

  async preCall(
    _payload: unknown,
    _context: GuardrailContext
  ): Promise<GuardrailResult<unknown> | void> {
    return { block: false };
  }

  async postCall(
    _response: unknown,
    _context: GuardrailContext
  ): Promise<GuardrailResult<unknown> | void> {
    return { block: false };
  }
}
