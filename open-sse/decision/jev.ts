// System One (jev) transport: one wire format, { model, state, questions } in and
// { model, answers, usage } out, shared by every gateway that resells it. Fails
// open everywhere — callers get null, never a throw.
//
// Ported 1:1 from the legacy fork (open-sse/decision/jev.js @ c66f917c).

type JsonRecord = Record<string, unknown>;

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 529]);

/** Decision models are advertised in a gateway's catalog with this type. */
export const DECISION_MODEL_TYPE = "evaluation";

/**
 * Resolve the same System One route used by the public endpoint and UI.
 *
 * The legacy fork read `providerEntry.systemOneConfig.baseUrl` off its provider
 * registry (config/providers.js). This base has no such provider-entry shape yet —
 * TODO(fork-port): when a decision-provider entry lands in
 * open-sse/config/providerRegistry.ts, give it a `systemOneConfig.baseUrl` (plus a
 * `transport.baseUrl`) and this function resolves the URL unchanged. Until then,
 * callers must pass a pre-resolved `url` to askJev.
 */
export function decisionUrlFor(providerEntry: JsonRecord | null | undefined): string | null {
  const raw = (providerEntry?.systemOneConfig as JsonRecord | undefined)?.baseUrl;
  if (!raw) return null;
  try {
    return new URL(
      String(raw),
      (providerEntry?.transport as JsonRecord | undefined)?.baseUrl as string | undefined
    ).toString();
  } catch {
    return null;
  }
}

/**
 * Resellers sometimes omit `confidence`, which would make every threshold read
 * `undefined` and discard every decision. The winning probability stands in.
 */
export function normalizeAnswers(answers: JsonRecord | null | undefined): JsonRecord {
  const out: JsonRecord = {};
  for (const [name, answer] of Object.entries(answers || {})) {
    if (!answer || typeof answer !== "object" || Array.isArray(answer)) continue;
    const a = answer as JsonRecord;
    if (a.type === "noul") {
      const value = Number(a.noul);
      out[name] = {
        type: "noul",
        noul: Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0,
      };
      continue;
    }
    const probabilities: JsonRecord = {};
    for (const [option, value] of Object.entries((a.probabilities as JsonRecord) || {})) {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1) {
        probabilities[option] = value;
      }
    }
    const probs = Object.values(probabilities) as number[];
    const confidence =
      typeof a.confidence === "number" ? a.confidence : probs.length ? Math.max(...probs) : 0;
    out[name] = { ...a, probabilities, confidence };
  }
  return out;
}

export type JevAnswer = JsonRecord;
export type JevResult = {
  answers: JsonRecord;
  usage: { input_tokens: number; output_tokens: number };
  model: string;
  latencyMs: number;
  route: unknown;
  rawPayload: JsonRecord;
};

/** One call to the decision model. Null on any failure. */
export async function askJev({
  url,
  model,
  apiKey,
  state,
  questions,
  headers = {},
  timeoutMs = 3000,
  fetchImpl = fetch,
  onFailure = null,
}: {
  url?: string | null;
  model?: string | null;
  apiKey?: string | null;
  state?: unknown;
  questions?: JsonRecord | null;
  headers?: JsonRecord;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  onFailure?: ((reason: string) => void) | null;
}): Promise<JevResult | null> {
  // Every null names its reason: a bare null is indistinguishable from an outage.
  const fail = (reason: string): null => {
    try {
      onFailure?.(reason);
    } catch {
      /* diagnostics must never break the fail-open path */
    }
    return null;
  };
  if (!apiKey) return fail("no_api_key");
  if (!url || !model) return fail("no_target");
  if (!questions || Object.keys(questions).length === 0) return fail("no_questions");

  const startedAt = Date.now();
  const once = async (): Promise<JsonRecord> => {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify({ model, state, questions }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw Object.assign(new Error(`${response.status} from ${url}: ${detail.slice(0, 200)}`), {
        status: response.status,
      });
    }
    return (await response.json()) as JsonRecord;
  };

  let payload: JsonRecord;
  try {
    payload = await once();
  } catch (error) {
    // A timeout is not retried: the service is slow, so a second attempt burns
    // another budget and still loses the decision (measured).
    if ((error as Error)?.name === "TimeoutError") return fail("timeout");
    const status = (error as { status?: number }).status;
    // 503 is retryable because the Vercel route emits it intermittently (measured).
    if (status !== undefined && !RETRYABLE.has(status)) return fail(`http_${status}`);
    try {
      payload = await once();
    } catch (retryError) {
      return fail(
        `retry_failed:${(retryError as { status?: number })?.status ?? (retryError as Error)?.name ?? "unknown"}`
      );
    }
  }

  const answers = normalizeAnswers(payload?.answers as JsonRecord);
  if (Object.keys(answers).length === 0) return fail("no_answers");
  const usage = (payload?.usage as JsonRecord | undefined) || {};
  return {
    answers,
    usage: {
      input_tokens: Number(usage.input_tokens) || 0,
      output_tokens: Number(usage.output_tokens) || 0,
    },
    model: (payload?.model as string) || model,
    latencyMs: Date.now() - startedAt,
    route:
      (payload?.provider_metadata as JsonRecord | undefined)?.gateway !== undefined
        ? (((payload?.provider_metadata as JsonRecord).gateway as JsonRecord).routing ?? null)
        : null,
    rawPayload: payload,
  };
}
