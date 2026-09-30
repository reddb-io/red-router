import {
  BaseGuardrail,
  type GuardrailContext,
  type GuardrailExecutionResult,
  type GuardrailResult,
} from "./base";
import { PIIMaskerGuardrail } from "./piiMasker";
import { PromptInjectionGuardrail } from "./promptInjection";
import { VisionBridgeGuardrail } from "./visionBridge";
import { AudioBridgeGuardrail } from "./audioBridge";
import { VideoBridgeGuardrail } from "./videoBridge";
import { CredentialMaskerGuardrail } from "./credentialMasker";
import { ContentFilterGuardrail } from "./contentFilter";

/**
 * `preCall`/`postCall` may legitimately return nothing — that is the documented
 * "no change" signal, alongside `{}` and `{ block: false }`
 * (`docs/security/GUARDRAILS.md`), and `CredentialMaskerGuardrail` still declares
 * the `| void` arm.
 *
 * `void` is not a value the checker lets us inspect, so neither `result?.block`
 * nor a truthiness test compiles against `GuardrailResult | void`. Funnel the
 * return through `unknown` once, here, and hand the dispatch loops a plain
 * optional. Runtime behavior is unchanged: a guardrail that returns nothing
 * still yields `undefined` and is still treated as "passed".
 */
function asGuardrailResult(raw: unknown): GuardrailResult<unknown> | undefined {
  return raw && typeof raw === "object" ? (raw as GuardrailResult<unknown>) : undefined;
}

type HeadersLike = Headers | Record<string, unknown> | null | undefined;

function isHeaderStore(headers: HeadersLike): headers is Headers {
  return Boolean(headers && typeof (headers as Headers).get === "function");
}

function getHeaderValue(headers: HeadersLike, name: string) {
  if (!headers) return null;
  if (isHeaderStore(headers)) return headers.get(name);

  const lowered = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lowered || typeof value !== "string") continue;
    return value;
  }

  return null;
}

function normalizeGuardrailName(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-");
}

function coerceDisabledGuardrails(value: unknown) {
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => normalizeGuardrailName(entry))
      .filter(Boolean);
  }

  if (!Array.isArray(value)) return [];

  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => normalizeGuardrailName(entry))
    .filter(Boolean);
}

function getGuardrailLogger(context: GuardrailContext) {
  return context.log || console;
}

/** Guardrails whose only effect is rewriting text; their edits are reported as "mask" events. */
const MASK_EVENT_GUARDRAILS = new Set(["pii-masker", "credential-masker"]);

function emitGuardrailEvent(
  context: GuardrailContext,
  guardrail: BaseGuardrail,
  stage: "request" | "response",
  execution: GuardrailExecutionResult
) {
  if (!context.recordEvent) return;
  try {
    if (execution.blocked) {
      const ruleId = execution.meta?.ruleId;
      context.recordEvent({
        guardrailId: guardrail.name,
        stage,
        action: "block",
        ruleId: typeof ruleId === "string" ? ruleId : null,
      });
    } else if (execution.modified && MASK_EVENT_GUARDRAILS.has(normalizeGuardrailName(guardrail.name))) {
      context.recordEvent({ guardrailId: guardrail.name, stage, action: "mask" });
    }
  } catch {
    // Monitoring must never affect the request.
  }
}

export function resolveDisabledGuardrails({
  apiKeyInfo,
  body,
  headers,
}: {
  apiKeyInfo?: Record<string, unknown> | null;
  body?: unknown;
  headers?: HeadersLike;
}): string[] {
  const bodyRecord = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  const metadata =
    bodyRecord?.metadata && typeof bodyRecord.metadata === "object"
      ? (bodyRecord.metadata as Record<string, unknown>)
      : null;
  const apiKeyDisabled =
    apiKeyInfo && typeof apiKeyInfo === "object"
      ? (apiKeyInfo as Record<string, unknown>).disabledGuardrails
      : undefined;
  const headerDisabled =
    getHeaderValue(headers, "x-omniroute-disabled-guardrails") ||
    getHeaderValue(headers, "x-disabled-guardrails");

  return [...coerceDisabledGuardrails(apiKeyDisabled)]
    .concat(coerceDisabledGuardrails(bodyRecord?.disabledGuardrails))
    .concat(coerceDisabledGuardrails(metadata?.disabledGuardrails))
    .concat(coerceDisabledGuardrails(headerDisabled))
    .filter((value, index, list) => list.indexOf(value) === index);
}

export class GuardrailRegistry {
  private guardrails: BaseGuardrail[] = [];

  register(guardrail: BaseGuardrail) {
    if (!(guardrail instanceof BaseGuardrail)) {
      throw new Error("Guardrail must extend BaseGuardrail");
    }

    this.guardrails = this.guardrails.filter(
      (existing) => normalizeGuardrailName(existing.name) !== normalizeGuardrailName(guardrail.name)
    );
    this.guardrails.push(guardrail);
    this.guardrails.sort((left, right) => left.priority - right.priority);
    return guardrail;
  }

  clear() {
    this.guardrails = [];
  }

  list() {
    return [...this.guardrails];
  }

  private isDisabled(guardrail: BaseGuardrail, context: GuardrailContext) {
    if (guardrail.honorsCallerOptOut === false) return false;
    const disabled = new Set(
      (context.disabledGuardrails || []).map((entry) => normalizeGuardrailName(entry))
    );
    return disabled.has(normalizeGuardrailName(guardrail.name));
  }

  /** Switched off by the operator's assignments for this request's key. */
  private isPlanDisabled(guardrail: BaseGuardrail, context: GuardrailContext) {
    const entry = context.guardrailPlan?.entries[normalizeGuardrailName(guardrail.name)];
    return entry?.enabled === false;
  }

  /**
   * The guardrails to walk for this request, in run order. Without a plan this is the registered
   * list unchanged (minus guardrails that only run when the plan activates them). With
   * assignments, priorities from the plan replace the registered ones.
   */
  private selectFor(context: GuardrailContext): BaseGuardrail[] {
    const plan = context.guardrailPlan ?? null;
    const active = this.guardrails.filter((guardrail) => guardrail.isActive(context));
    if (!plan || Object.keys(plan.entries).length === 0) return active;

    const priorityOf = (guardrail: BaseGuardrail) =>
      plan.entries[normalizeGuardrailName(guardrail.name)]?.priority ?? guardrail.priority;
    return [...active].sort(
      (left, right) =>
        priorityOf(left) - priorityOf(right) || left.name.localeCompare(right.name)
    );
  }

  async runPreCallHooks<TPayload = unknown>(payload: TPayload, context: GuardrailContext = {}) {
    const logger = getGuardrailLogger(context);
    const results: GuardrailExecutionResult[] = [];
    let currentPayload = payload;

    for (const guardrail of this.selectFor(context)) {
      if (
        !guardrail.enabled ||
        this.isDisabled(guardrail, context) ||
        this.isPlanDisabled(guardrail, context)
      ) {
        results.push({
          blocked: false,
          guardrail: guardrail.name,
          modified: false,
          skipped: true,
          stage: "pre",
        });
        continue;
      }

      try {
        const result = asGuardrailResult(await guardrail.preCall(currentPayload, context));
        const modified = result?.modifiedPayload !== undefined;
        const meta = result?.meta || null;

        if (modified) {
          currentPayload = result?.modifiedPayload as TPayload;
        }

        const execution: GuardrailExecutionResult = {
          blocked: result?.block === true,
          guardrail: guardrail.name,
          message: result?.message,
          meta,
          modified,
          skipped: false,
          stage: "pre",
        };
        results.push(execution);
        emitGuardrailEvent(context, guardrail, "request", execution);

        logger.debug?.(
          "GUARDRAIL",
          `${guardrail.name} pre-call ${execution.blocked ? "blocked" : modified ? "modified" : "passed"}`,
          meta || undefined
        );

        if (execution.blocked) {
          return {
            blocked: true,
            guardrail: guardrail.name,
            message: result?.message,
            payload: currentPayload,
            results,
          };
        }
      } catch (error) {
        if (context.signal?.aborted) {
          throw new Error("Guardrail processing aborted");
        }
        const message = error instanceof Error ? error.message : String(error);
        results.push({
          blocked: false,
          error: message,
          guardrail: guardrail.name,
          modified: false,
          skipped: false,
          stage: "pre",
        });
        logger.warn?.("GUARDRAIL", `${guardrail.name} pre-call failed open`, { error: message });
      }
    }

    return {
      blocked: false,
      payload: currentPayload,
      results,
    };
  }

  async runPostCallHooks<TResponse = unknown>(response: TResponse, context: GuardrailContext = {}) {
    const logger = getGuardrailLogger(context);
    const results: GuardrailExecutionResult[] = [];
    let currentResponse = response;

    for (const guardrail of this.selectFor(context)) {
      if (
        !guardrail.enabled ||
        this.isDisabled(guardrail, context) ||
        this.isPlanDisabled(guardrail, context)
      ) {
        results.push({
          blocked: false,
          guardrail: guardrail.name,
          modified: false,
          skipped: true,
          stage: "post",
        });
        continue;
      }

      try {
        const result = asGuardrailResult(await guardrail.postCall(currentResponse, context));
        const modified = result?.modifiedResponse !== undefined;
        const meta = result?.meta || null;

        if (modified) {
          currentResponse = result?.modifiedResponse as TResponse;
        }

        const execution: GuardrailExecutionResult = {
          blocked: result?.block === true,
          guardrail: guardrail.name,
          message: result?.message,
          meta,
          modified,
          skipped: false,
          stage: "post",
        };
        results.push(execution);
        emitGuardrailEvent(context, guardrail, "response", execution);

        logger.debug?.(
          "GUARDRAIL",
          `${guardrail.name} post-call ${execution.blocked ? "blocked" : modified ? "modified" : "passed"}`,
          meta || undefined
        );

        if (execution.blocked) {
          return {
            blocked: true,
            guardrail: guardrail.name,
            message: result?.message,
            response: currentResponse,
            results,
          };
        }
      } catch (error) {
        if (context.signal?.aborted) {
          throw new Error("Guardrail processing aborted");
        }
        const message = error instanceof Error ? error.message : String(error);
        results.push({
          blocked: false,
          error: message,
          guardrail: guardrail.name,
          modified: false,
          skipped: false,
          stage: "post",
        });
        logger.warn?.("GUARDRAIL", `${guardrail.name} post-call failed open`, { error: message });
      }
    }

    return {
      blocked: false,
      response: currentResponse,
      results,
    };
  }
}

export const guardrailRegistry = new GuardrailRegistry();

let defaultGuardrailsRegistered = false;

export function registerDefaultGuardrails() {
  if (defaultGuardrailsRegistered) return guardrailRegistry;

  guardrailRegistry.register(new VisionBridgeGuardrail());
  guardrailRegistry.register(new AudioBridgeGuardrail());
  guardrailRegistry.register(new VideoBridgeGuardrail());
  guardrailRegistry.register(new ContentFilterGuardrail());
  guardrailRegistry.register(new PIIMaskerGuardrail());
  guardrailRegistry.register(new CredentialMaskerGuardrail());
  guardrailRegistry.register(new PromptInjectionGuardrail());
  defaultGuardrailsRegistered = true;

  return guardrailRegistry;
}

export function resetGuardrailsForTests({ registerDefaults = true } = {}) {
  guardrailRegistry.clear();
  defaultGuardrailsRegistered = false;
  if (registerDefaults) {
    registerDefaultGuardrails();
  }
}

registerDefaultGuardrails();
