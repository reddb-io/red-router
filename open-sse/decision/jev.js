// System One (jev) transport: one wire format, { model, state, questions } in and
// { model, answers, usage } out, shared by every gateway that resells it. Fails
// open everywhere — callers get null, never a throw.

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 529]);

/** Decision models are advertised in a gateway's catalog with this type. */
export const DECISION_MODEL_TYPE = "evaluation";

/** Resolve the same System One route used by the public endpoint and UI. */
export function decisionUrlFor(providerEntry) {
  const raw = providerEntry?.systemOneConfig?.baseUrl;
  if (!raw) return null;
  try {
    return new URL(raw, providerEntry?.transport?.baseUrl).toString();
  } catch {
    return null;
  }
}

/**
 * Resellers sometimes omit `confidence`, which would make every threshold read
 * `undefined` and discard every decision. The winning probability stands in.
 */
export function normalizeAnswers(answers) {
  const out = {};
  for (const [name, answer] of Object.entries(answers || {})) {
    if (!answer || typeof answer !== "object") continue;
    if (answer.type === "noul") {
      const value = Number(answer.noul);
      out[name] = { type: "noul", noul: Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0 };
      continue;
    }
    const probabilities = {};
    for (const [option, value] of Object.entries(answer.probabilities || {})) {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1) {
        probabilities[option] = value;
      }
    }
    const probs = Object.values(probabilities);
    const confidence = typeof answer.confidence === "number"
      ? answer.confidence
      : (probs.length ? Math.max(...probs) : 0);
    out[name] = { ...answer, probabilities, confidence };
  }
  return out;
}

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
}) {
  // Every null names its reason: a bare null is indistinguishable from an outage.
  const fail = (reason) => {
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
  const once = async () => {
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
    return response.json();
  };

  let payload;
  try {
    payload = await once();
  } catch (error) {
    // A timeout is not retried: the service is slow, so a second attempt burns
    // another budget and still loses the decision (measured).
    if (error?.name === "TimeoutError") return fail("timeout");
    const status = error?.status;
    // 503 is retryable because the Vercel route emits it intermittently (measured).
    if (status !== undefined && !RETRYABLE.has(status)) return fail(`http_${status}`);
    try {
      payload = await once();
    } catch (retryError) {
      return fail(`retry_failed:${retryError?.status ?? retryError?.name ?? "unknown"}`);
    }
  }

  const answers = normalizeAnswers(payload?.answers);
  if (Object.keys(answers).length === 0) return fail("no_answers");
  return {
    answers,
    usage: {
      input_tokens: payload?.usage?.input_tokens || 0,
      output_tokens: payload?.usage?.output_tokens || 0,
    },
    model: payload?.model || model,
    latencyMs: Date.now() - startedAt,
    route: payload?.provider_metadata?.gateway?.routing || null,
    rawPayload: payload,
  };
}
