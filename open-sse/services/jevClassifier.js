/**
 * Jev (TypeSafe "System One") routing classifier.
 *
 * Jev is a decision model, not an LLM: send it a `state` + `questions`, get back
 * typed probabilities. We ask ONE `choice` question — the complexity tier of the
 * coding task — and use it to reorder a combo so the tier-appropriate model leads.
 * The existing availability/quota fallback ladder in combo.js is then untouched.
 *
 * Fail-open by contract (like rtk/): on ANY error — no key, timeout, HTTP error,
 * malformed response, unknown tier, low confidence, or an open circuit breaker —
 * classifyTier() returns null and the caller keeps the existing combo order.
 * The classifier must never be a single point of failure for routing.
 */

import { trailingUserItems } from "./combo.js";
import { extractTextContent } from "../translator/formats/gemini.js";
import {
  JEV_ENDPOINT_PATH,
  JEV_DEFAULT_BASE,
  JEV_DEFAULT_MODEL,
  JEV_TIERS,
  JEV_DEFAULT_CRITERIA,
  JEV_DEFAULT_INSTRUCTIONS,
  JEV_STATE_CHAR_BUDGET,
  JEV_TIMEOUT_MS,
  JEV_BREAKER_COOLDOWN_MS,
  JEV_MIN_CONFIDENCE,
  JEV_INPUT_PRICE_PER_MTOK,
  JEV_OUTPUT_PRICE_PER_MTOK,
} from "../config/jev.js";

/**
 * Process-local circuit breaker. Skips Jev calls for a cooldown after a
 * recognized timeout, then lets one request probe recovery. Not coordinated
 * across workers (matches LiteLLM's documented per-instance behaviour).
 * @type {{ openUntil: number, halfOpen: boolean }}
 */
const breaker = { openUntil: 0, halfOpen: false };

/** Test/reset hook: clear breaker state. */
export function resetJevBreaker() {
  breaker.openUntil = 0;
  breaker.halfOpen = false;
}

/** Is the breaker currently open (and not yet probing)? */
function breakerOpen(now) {
  if (breaker.openUntil === 0) return false;
  if (now >= breaker.openUntil) {
    // Cooldown elapsed — allow exactly one probe (half-open).
    if (!breaker.halfOpen) {
      breaker.halfOpen = true;
      return false;
    }
    return true;
  }
  return true;
}

function tripBreaker(now, cooldownMs) {
  breaker.openUntil = now + cooldownMs;
  breaker.halfOpen = false;
}

function closeBreaker() {
  breaker.openUntil = 0;
  breaker.halfOpen = false;
}

/**
 * Build a bounded `state` from the current user turn only (never the whole
 * transcript or tool_result blobs). Reuses combo.js's trailingUserItems so the
 * "current ask" definition matches the capability auto-switch path.
 *
 * @param {object} body - client request body (OpenAI/Claude/Gemini/Responses)
 * @param {number} [charBudget]
 * @returns {string} state text (may be "")
 */
export function buildJevState(body, charBudget = JEV_STATE_CHAR_BUDGET) {
  if (!body || typeof body !== "object") return "";
  const parts = [];

  const pushText = (t) => {
    if (typeof t === "string" && t.trim()) parts.push(t.trim());
  };

  // OpenAI / Claude / Hermes / Ollama
  for (const m of trailingUserItems(body.messages)) pushText(extractTextContent(m?.content));
  // OpenAI Responses
  for (const it of trailingUserItems(body.input)) pushText(extractTextContent(it?.content));
  // Gemini / Antigravity
  const contents = body.contents || body.request?.contents;
  for (const c of trailingUserItems(contents)) {
    if (Array.isArray(c?.parts)) for (const p of c.parts) pushText(p?.text);
  }

  let state = parts.join("\n").slice(0, charBudget);
  return state;
}

/**
 * Classify the request into a complexity tier via Jev.
 *
 * @param {object} opts
 * @param {object} opts.body - client request body
 * @param {object} [opts.log] - logger ({info,warn,debug}); optional
 * @param {string} [opts.apiKey] - TypeSafe key; defaults to process.env.TYPESAFE_API_KEY
 * @param {string} [opts.baseUrl] - defaults to process.env.TYPESAFE_API_BASE or JEV_DEFAULT_BASE
 * @param {string} [opts.model] - defaults to JEV_DEFAULT_MODEL
 * @param {object} [opts.criteria] - tier criteria; defaults to JEV_DEFAULT_CRITERIA
 * @param {string} [opts.instructions] - defaults to JEV_DEFAULT_INSTRUCTIONS
 * @param {number} [opts.timeoutMs] - defaults to JEV_TIMEOUT_MS
 * @param {number} [opts.minConfidence] - defaults to JEV_MIN_CONFIDENCE
 * @param {boolean} [opts.breakerEnabled=true]
 * @param {function} [opts.fetchImpl=fetch] - injectable for tests
 * @param {function} [opts.now=Date.now] - injectable for tests
 * @returns {Promise<{tier:string,confidence:number,probabilities:object,model:string,spendUsd:number,source:"jev"}|null>}
 *          null on ANY failure / low confidence / open breaker (fail-open).
 */
export async function classifyTier(opts = {}) {
  const {
    body,
    log = { info() {}, warn() {}, debug() {} },
    apiKey = process.env.TYPESAFE_API_KEY,
    baseUrl = (process.env.TYPESAFE_API_BASE || JEV_DEFAULT_BASE).replace(/\/+$/, ""),
    model = JEV_DEFAULT_MODEL,
    criteria = JEV_DEFAULT_CRITERIA,
    instructions = JEV_DEFAULT_INSTRUCTIONS,
    timeoutMs = JEV_TIMEOUT_MS,
    minConfidence = JEV_MIN_CONFIDENCE,
    breakerEnabled = true,
    fetchImpl = (...a) => fetch(...a),
    now = () => Date.now(),
  } = opts;

  const t0 = now();

  if (!apiKey) {
    log.debug?.("JEV", "no TYPESAFE_API_KEY — skipping classifier (fail-open)");
    return null;
  }

  const state = buildJevState(body);
  if (!state) {
    log.debug?.("JEV", "empty state — skipping classifier (fail-open)");
    return null;
  }

  if (breakerEnabled && breakerOpen(t0)) {
    log.debug?.("JEV", "circuit breaker open — skipping classifier (fail-open)");
    return null;
  }

  const payload = {
    model,
    state,
    questions: { tier: { type: "choice", instructions, criteria } },
  };

  let res;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    res = await fetchImpl(`${baseUrl}${JEV_ENDPOINT_PATH}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
  } catch (e) {
    const isTimeout = e?.name === "AbortError";
    if (isTimeout && breakerEnabled) tripBreaker(now(), JEV_BREAKER_COOLDOWN_MS);
    log.warn?.("JEV", isTimeout ? "classifier timed out — fail-open" : `classifier fetch error — fail-open: ${e?.message || e}`);
    return null;
  } finally {
    clearTimeout(timer);
  }

  if (!res || res.status !== 200) {
    log.warn?.("JEV", `classifier HTTP ${res?.status} — fail-open`);
    return null;
  }

  let json;
  try {
    json = await res.json();
  } catch (e) {
    log.warn?.("JEV", `classifier unparseable response — fail-open: ${e?.message || e}`);
    return null;
  }

  const ans = json?.answers?.tier;
  const tier = ans?.choice;
  const confidence = typeof ans?.confidence === "number" ? ans.confidence : null;
  const probabilities = ans?.probabilities && typeof ans.probabilities === "object" ? ans.probabilities : null;

  // Validate: known tier + sufficient confidence.
  if (!tier || !JEV_TIERS.includes(tier)) {
    log.warn?.("JEV", `unknown tier "${tier}" — fail-open`);
    return null;
  }
  if (confidence == null || confidence < minConfidence) {
    log.info?.("JEV", `low confidence (${confidence}) for tier ${tier} — keeping existing order`);
    return null;
  }

  // Successful classification — close a half-open breaker.
  if (breakerEnabled) closeBreaker();

  const usage = json?.usage || {};
  const spendUsd =
    ((usage.input_tokens || 0) / 1e6) * JEV_INPUT_PRICE_PER_MTOK +
    ((usage.output_tokens || 0) / 1e6) * JEV_OUTPUT_PRICE_PER_MTOK;

  const elapsed = now() - t0;
  log.info?.("JEV", `tier=${tier} conf=${confidence.toFixed(3)} in ${elapsed}ms (spend $${spendUsd.toFixed(8)})`);

  return {
    tier,
    confidence,
    probabilities,
    model: json?.model || model,
    spendUsd,
    source: "jev",
  };
}
