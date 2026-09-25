// App-side glue: reads the operator's settings, resolves the gateway credential, and
// turns jev's answers into an ordered model list or a tool mode. The gateway IS the
// provider, so one key covers chat and decisions. Swapping the decision model is
// editing `model`.
//
// The pure parts live in open-sse/decision/ and import nothing from src/.

import REGISTRY from "open-sse/providers/registry/index.js";
import { getProviderCredentials } from "./auth.js";
import { systemOneCredentialProviders } from "open-sse/config/systemOne.js";
import { askJev, decisionUrlFor } from "open-sse/decision/jev.js";
import { buildState } from "open-sse/decision/state.js";
import { extractSignals, isEncryptedTask, signalsMeta } from "open-sse/decision/signals.js";
import { localDeliberation } from "open-sse/decision/localScorer.js";
import {
  autopilotApplies,
  decideReasoningLevel,
  normalizeAutopilotConfig,
  parseReasoningHeader,
} from "open-sse/decision/reasoningAutopilot.js";
import { buildModelQuestions, buildReasoningQuestions, buildToolQuestions, shortlistTools, DELIBERATION_KEY } from "open-sse/decision/questions.js";
import { HINT_SOURCE, hintEffort } from "open-sse/decision/clientHint.js";
import { modelContextWindow, estimateRequestTokens } from "open-sse/services/combo.js";
import { resolveModelDecision, resolveToolDecision } from "open-sse/decision/decide.js";
import { getPricingForModel } from "open-sse/providers/pricing.js";
import { providerIdentity } from "open-sse/providers/identity.js";
import { resolveProviderAlias } from "open-sse/services/model.js";
import { resolveCriteria } from "open-sse/decision/modelBriefs.js";
import { rankByCost } from "open-sse/decision/decide.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { MEMORY_CONFIG, REASONING_HEADER } from "open-sse/config/runtimeConfig.js";
import { createHash } from "node:crypto";

export const DEFAULT_DECISION = {
  mode: "off",
  provider: "vercel-ai-gateway",
  model: "typesafe-ai/jev",
  effort: false,
  toolMode: "hint",
  // Winner strength, not confidence (see decide.js): jev scales its confidence by
  // the option count, so the same winner reads 1.00 in a pool of 3 and 0.31 in a
  // pool of 12. Calibrated on 383 production verdicts over the 12-model pool.
  minStrength: 0.35,
  switchStrength: 0.6,
  // Switching away from the member whose prompt cache is warm needs a clearer
  // verdict (or a second agreeing one), since the switch re-pays the prompt.
  cacheSwitchStrength: 0.75,
  timeoutMs: 1500,
};

export function normalizeDecisionConfig(raw) {
  const config = { ...DEFAULT_DECISION, ...(raw || {}) };
  if (!Number.isFinite(config.timeoutMs)) config.timeoutMs = DEFAULT_DECISION.timeoutMs;
  return config;
}

/** The raw registry entry, which carries `transport` and `systemOneConfig`. */
function registryEntry(providerId) {
  return REGISTRY.find((entry) => entry.id === providerId || entry.alias === providerId) || null;
}

/** Gateways that can serve a decision model. */
export function decisionProviders() {
  return REGISTRY.filter((entry) => entry.systemOneConfig)
    .map((entry) => ({
      id: entry.id,
      name: entry.display?.name || entry.id,
      defaultModel: entry.systemOneConfig.defaultModel || null,
      modelType: entry.systemOneConfig.modelType || null,
    }));
}

/**
 * Resolve everything needed to ask the decision model, or null.
 *
 * The lock key is namespaced per gateway: without its own scope the account
 * breaker would take the shared chat provider offline for chat too.
 */
export async function resolveDecisionTarget(config, { apiKey = null, log } = {}) {
  const entry = registryEntry(config.provider);
  const url = decisionUrlFor(entry);
  if (!url) {
    log?.warn?.("DECISION", `${config.provider} declares no decision route`);
    return null;
  }
  const lockKey = `decision:${entry.id}`;
  try {
    const credentials = await decisionCredentials(entry.id, lockKey, apiKey);
    if (!credentials) {
      log?.info?.("DECISION", `no active credentials for ${entry.id} - decisions disabled`);
      return null;
    }
    const key = credentials?.apiKey || credentials?.accessToken || null;
    if (!key) return null;
    log?.info?.("DECISION", `using ${credentials.provider || entry.id} credential for the decision route`);
    const providerData = credentials?.providerSpecificData || {};
    const proxyOptions = {
      connectionProxyEnabled: providerData.connectionProxyEnabled === true,
      connectionProxyUrl: providerData.connectionProxyUrl || "",
      connectionNoProxy: providerData.connectionNoProxy || "",
      vercelRelayUrl: providerData.vercelRelayUrl || "",
    };
    return {
      url,
      apiKey: key,
      provider: entry.id,
      headers: entry.systemOneConfig?.headers || {},
      // The account and the caller that caused the decision, so its usage row lands
      // under them instead of reading as an unattributed local call.
      connectionId: credentials?.connectionId || null,
      callerApiKey: apiKey,
      fetchImpl: (url, options) => proxyAwareFetch(url, options, proxyOptions),
    };
  } catch (error) {
    log?.warn?.("DECISION", `credential lookup failed: ${error.message}`);
    return null;
  }
}

/**
 * The gateway's own account, else an account whose key also reaches its decision
 * route (an OpenCode Go key serves the workspace's Zen JEV models).
 */
async function decisionCredentials(providerId, lockKey, apiKey) {
  for (const provider of systemOneCredentialProviders(providerId)) {
    const credentials = await getProviderCredentials(provider, new Set(), lockKey, { apiKey });
    if (credentials && !credentials.noActiveCredentials) return { ...credentials, provider };
  }
  return null;
}

/** What each model is FOR, without its price: the decision model is asked to judge
 *  fitness only. Costs are compared later, and only among the models it rated alike. */
function criteriaResolver(config) {
  return (model) => {
    const slash = model.indexOf("/");
    const provider = slash > 0 ? model.slice(0, slash) : "";
    const id = slash > 0 ? model.slice(slash + 1) : model;
    return resolveCriteria({ provider, model: id, briefs: config.briefs });
  };
}

/** Input price per million tokens. The pool carries provider ALIASES ("br/…"),
 *  and the pricing tables are keyed by provider id ("bedrock/…") — passing the
 *  alias silently returns null, which would sort a $5 Opus to the bottom of the
 *  pool as if it were unpriced. Null only when the model is genuinely unlisted. */
export function priceOf(model) {
  const slash = model.indexOf("/");
  if (slash <= 0) return null;
  const price = getPricingForModel(model.slice(0, slash), model.slice(slash + 1));
  return typeof price?.input === "number" ? price.input : null;
}

// Expected answer length when the request does not say: most turns are short,
// and a max_tokens is a ceiling, not a forecast, so it is capped.
const DEFAULT_OUTPUT_TOKENS = 1000;
const MAX_EXPECTED_OUTPUT_TOKENS = 4000;
// Share of the prompt a warm session reads from the provider's cache.
const WARM_CACHE_SHARE = 0.9;

/**
 * What one request would cost on each model, in dollars: the prompt at the input
 * price (most of it at the cached price on the member whose cache is warm), plus
 * the expected answer at the output price. Null for an unpriced model. Replaces
 * the input price alone, which ranked a cheap-input, expensive-output model first
 * and ignored that switching away from a warm cache pays the prompt in full.
 */
export function requestCostOf(body, { inputTokens = null, warmMember = null } = {}) {
  const prompt = Number.isFinite(inputTokens) ? inputTokens : estimateRequestTokens(body || {});
  const limit = Number(body?.max_tokens ?? body?.max_completion_tokens ?? body?.max_output_tokens ?? body?.generationConfig?.maxOutputTokens);
  const output = Number.isFinite(limit) && limit > 0 ? Math.min(limit, MAX_EXPECTED_OUTPUT_TOKENS) : DEFAULT_OUTPUT_TOKENS;
  return (model) => {
    const slash = model.indexOf("/");
    if (slash <= 0) return null;
    // A subscription account (OAuth, web cookie, free) bills no tokens: this
    // request costs nothing extra there, whatever the model's list price.
    if (providerIdentity(resolveProviderAlias(model.slice(0, slash)))?.subscription) return 0;
    const price = getPricingForModel(model.slice(0, slash), model.slice(slash + 1));
    if (typeof price?.input !== "number") return null;
    const outputPrice = typeof price.output === "number" ? price.output : price.input;
    const cachedShare = model === warmMember && typeof price.cached === "number" ? WARM_CACHE_SHARE : 0;
    const inputCost = prompt * ((1 - cachedShare) * price.input + cachedShare * (price.cached ?? price.input));
    return (inputCost + output * outputPrice) / 1e6;
  };
}

/**
 * The decision pool: every model the combo can really reach, cheapest first.
 *
 * A combo-of-combos lists tier names, not models, and a name carries no price —
 * PATTERN_PRICING's `claude-*` catch-all would give a combo called "claude-auto"
 * a $3 that means nothing. So each nested combo is expanded to its own members and
 * the pick is made among the models themselves, which is the whole point: within
 * those members there is a best one for this task.
 *
 * Order of first appearance is kept and duplicates dropped — the same cheap
 * fallback sits in several tiers, and listing it three times would weight the
 * ranking toward it.
 *
 * ponytail: one level of nesting, which is the depth the combo editor can build.
 * A deeper tree keeps the inner combo as one entry rather than recursing.
 */
export async function rankPool(models, resolveMember) {
  const expanded = [];
  for (const model of models) {
    if (model.includes("/")) { expanded.push(model); continue; }
    const members = (await resolveMember(model)) || [];
    expanded.push(...(members.length ? members : [model]));
  }
  const unique = [...new Set(expanded)];
  return rankByCost(unique, priceOf);
}

/** Whether the request carries an Anthropic `thinking` block. Anthropic refuses a
 *  pinned tool_choice in that mode ("Thinking mode does not support this
 *  tool_choice"). The test is the field itself, not the intent: an OpenAI target
 *  gets `reasoning_effort`, which places no such restriction on tool_choice. */
function hasAnthropicThinking(body) {
  const type = body?.thinking?.type;
  return typeof type === "string" && type !== "disabled";
}

const ask = (target, config, state, questions, log) =>
  askJev({
    url: target.url,
    model: config.model,
    apiKey: target.apiKey,
    state,
    questions,
    headers: target.headers,
    timeoutMs: config.timeoutMs,
    fetchImpl: target.fetchImpl,
    onFailure: (reason) => log?.info?.("DECISION", `decision model returned nothing (${reason})`),
  }).then((response) => (response ? { ...response, state, questions } : response));

/**
 * Auto-combo: which model of the pool should serve this turn.
 *
 * The conversation is read from the RAW client body, because by the time the body
 * is translated the target provider is fixed and the model can no longer change
 * in this request.
 *
 * Returns the pool reordered with the pick first, or the pool unchanged. An
 * unapplied decision is not an error: the caller's fallback loop walks the rest of
 * the list, so a wrong pick costs one attempt rather than a failure.
 *
 * `hintedDeliberation` is the deliberation the client already stated
 * (x-red-router-hint). When it is a number the `needs_reasoning` question is not
 * asked and that value answers it; jev is still asked which model fits, because
 * the hint names no model.
 */
export async function decideComboModel({ body, models, comboName, config, target, log, previousVerdict = null, ranked = null, signals = null, hintedDeliberation = null, warmMember = null }) {
  // Cheapest first by what this request would cost, and the list both the question
  // and the verdict are served from. The question MUST be built over this pool: for
  // a combo-of-combos `models` holds tier names, so asking with those and validating
  // against the expanded pool has jev answer a tier name the pool does not contain —
  // every verdict discarded as `no_usable_pick`, measured at 243 of 243 calls.
  const costOf = requestCostOf(body, { inputTokens: signals?.contextTokens ?? null, warmMember });
  const pool = rankByCost(ranked?.length ? ranked : models, costOf);
  if (pool.length < 2) return { models, decision: null };

  // Bookkeeping (session titles): the cheapest member, no decision call. Asking
  // spends a call on it, and a title prompt quoting the session reads as hard work.
  if (signals?.housekeeping) {
    const decision = { apply: true, reason: "housekeeping", cause: "housekeeping", model: pool[0], deliberation: 0, signals: signalsMeta(signals) };
    log?.info?.("DECISION", `model: ${pool[0]} for "${comboName}" (housekeeping, no decision call)`);
    return { models: [pool[0], ...pool.slice(1)], decision };
  }

  // An encrypted delegated task gives the decision model nothing but ciphertext.
  if (signals?.encryptedTask) {
    log?.info?.("DECISION", `model: no decision for "${comboName}" (encrypted agent task)`);
    return { models, decision: null, reason: "encrypted_task" };
  }

  const hinted = typeof hintedDeliberation === "number" && Number.isFinite(hintedDeliberation);
  const { questions } = buildModelQuestions(pool, criteriaResolver(config), { deliberation: !hinted });
  const state = buildState(body, { maxStateChars: 24000, dropSystem: signals?.harnessSystem === true });
  const response = await ask(target, config, state, questions, log);

  if (!response) {
    const local = localComboPick(pool, signals);
    if (local) {
      log?.info?.("DECISION", `model: ${local.model} for "${comboName}" (jev unavailable, local score ${fmt(local.score)})`);
      return { models: [local.model, ...pool.filter((m) => m !== local.model)], decision: local.decision };
    }
    log?.info?.("DECISION", "model: verdict discarded, pool order unchanged");
    return { models, decision: null, reason: "ask_failed" };
  }

  const answers = hinted
    ? { ...response.answers, [DELIBERATION_KEY]: { type: "noul", noul: Math.max(0, Math.min(1, hintedDeliberation)) } }
    : response.answers;
  const resolved = resolveModelDecision({
    answers,
    models: pool,
    priceOf: costOf,
    minStrength: config.minStrength,
    switchStrength: config.switchStrength,
    // Leaving the member whose prompt cache is warm pays the whole prompt again.
    warmMember,
    cacheSwitchStrength: config.cacheSwitchStrength,
    previousVerdict,
    needsDeliberation: signals?.planMode === true || signals?.stall === true,
  });
  const decision = hinted ? { ...resolved, deliberationSource: HINT_SOURCE } : resolved;
  const cause = deliberationCause(signals);
  if (cause) decision.cause = cause;
  if (signals) decision.signals = signalsMeta(signals);

  await recordUsage({ response, log, target, verdict: verdictMeta(decision, { kind: "model", comboName }) });

  if (!decision.apply) {
    log?.info?.("DECISION", `model: no change (${decision.reason}, conf ${fmt(decision.confidence)}, ${response.latencyMs}ms)`);
    return { models, decision, reason: decision.reason };
  }

  log?.info?.(
    "DECISION",
    `model: ${decision.model} for "${comboName}" (conf ${fmt(decision.confidence)}, deliberar ${fmt(decision.deliberation)}, ${response.latencyMs}ms)`
  );
  return { models: [decision.model, ...pool.filter((m) => m !== decision.model)], decision };
}

// Local fallback bands: only a clear score moves the pool when jev is silent.
const LOCAL_HARD = 0.7;
const LOCAL_EASY = 0.2;

/**
 * When jev cannot answer: a clearly hard turn goes to the priciest priced member
 * (the pool's strongest, by the only measure available), a clearly easy one to the
 * cheapest; anything in between leaves the order alone.
 */
function localComboPick(pool, signals) {
  if (!signals || signals.encryptedTask) return null;
  const { score, reasons } = localDeliberation(signals);
  // List price stands in for capability here — not what the request would cost,
  // which is zero on a subscription account whatever the model.
  const priced = rankByCost(pool.filter((m) => priceOf(m) !== null), priceOf);
  if (priced.length < 2) return null;
  const model = score >= LOCAL_HARD ? priced[priced.length - 1] : score <= LOCAL_EASY ? priced[0] : null;
  if (!model) return null;
  // No deliberation is handed on: the reasoning autopilot scores the turn itself.
  return { model, score, decision: { apply: true, reason: "local_score", cause: "local", model, deliberation: null, localScore: score, localReasons: reasons, signals: signalsMeta(signals) } };
}

/**
 * An `ask(state, questions)` for the relevance saver, bound to the configured
 * decision gateway, or null when none is reachable. Its usage row is recorded like
 * any other decision.
 */
export async function relevanceAsker(settings, { apiKey = null, log } = {}) {
  const config = normalizeDecisionConfig(settings?.decisionRouter);
  const target = await resolveDecisionTarget(config, { apiKey, log });
  if (!target) return null;
  return async (state, questions) => {
    const response = await ask(target, config, state, questions, log);
    if (!response) return null;
    await recordUsage({ response, log, target, verdict: { kind: "relevance", questions: Object.keys(questions).length } });
    return response.answers;
  };
}

/**
 * Tool routing: which tool the model should call next, if any. The caller decides
 * whether to apply it, which is what makes shadow mode measurable.
 */
export async function decideTool({ body, tools, plans = [], config, target, log }) {
  if (tools.length === 0) return null;
  if (isEncryptedTask(body)) return null;

  const kept = shortlistTools(tools, body);
  const { questions } = buildToolQuestions(kept);
  // A much smaller window than the model decision uses: the conversation dominates
  // a decision's cost (~3,400 of 4,442 input tokens at 30 turns, against ~740 for a
  // 21-tool roster) and "what next" needs the latest request, not the whole
  // transcript. Runs once per turn and is the verdict most often discarded.
  // ponytail: fixed ceiling; raise it if long sessions start picking worse.
  const state = buildState(body, { maxStateChars: 6000 });
  const response = await ask(target, config, state, questions, log);
  if (!response) return null;

  const toolDecision = resolveToolDecision({
    answers: response.answers,
    tools: kept.map((t) => t.name),
    plans,
    allowed: config.toolMode,
    minConfidence: config.minConfidence,
    // A pinned tool_choice is rejected upstream while thinking is on, so the
    // verdict is capped to a hint there rather than turning into a 400.
    extendedThinking: hasAnthropicThinking(body),
  });
  await recordUsage({ response, log, target, verdict: verdictMeta(toolDecision, { kind: "tool", tools: kept.length }) });

  return { ...toolDecision, latencyMs: response.latencyMs };
}

/**
 * Its own usage row, under its own model: folded into the main request these tokens
 * would be priced at the serving model's rate. PROVIDER_PRICING's `typesafe` entry
 * is what lets calculateCost price them at all.
 *
 * The row carries the verdict in `meta`, so the table answers "why did this request
 * reach an expensive model" and not only "how much did it spend".
 */
async function recordUsage({ response, log, verdict, target }) {
  try {
    const { saveRequestUsage } = await import("@/lib/db/index.js");
    await saveRequestUsage({
      provider: target?.provider || "typesafe",
      model: response.model || "jev-latest",
      endpoint: "decision",
      connectionId: target?.connectionId || null,
      apiKey: target?.callerApiKey || null,
      tokens: {
        prompt_tokens: response.usage.input_tokens,
        completion_tokens: response.usage.output_tokens,
      },
      meta: verdict ? { ...verdict, route: response.route, via: target?.provider || null } : undefined,
    });
    await saveDecisionDetail({ response, verdict, target });
  } catch (error) {
    log?.debug?.("DECISION", `usage not recorded: ${error.message}`);
  }
}

async function saveDecisionDetail({ response, verdict, target }) {
  const questions = response.questions;
  try {
    const { saveRequestDetail } = await import("@/lib/usageDb.js");
    const { buildRequestDetail, buildDecisionDetail } = await import("open-sse/handlers/chatCore/requestDetail.js");
    const answers = response.answers || {};
    const probabilities = {};
    for (const [k, v] of Object.entries(answers)) {
      if (v?.probabilities) probabilities[k] = v.probabilities;
    }
    await saveRequestDetail(buildRequestDetail({
      provider: target?.provider || "typesafe",
      model: response.model || "jev-latest",
      connectionId: target?.connectionId || undefined,
      apiKey: target?.callerApiKey || undefined,
      latency: { ttft: null, total: response.latencyMs ?? null },
      tokens: {
        prompt_tokens: response.usage.input_tokens,
        completion_tokens: response.usage.output_tokens,
      },
      request: { kind: verdict?.kind || null, questions: questions || null },
      decisionState: response.state || null,
      endpoint: "decision",
      providerRequest: { model: response.model, route: response.route?.canonicalSlug || null },
      providerResponse: { answers, probabilities },
      response: { verdict: verdict || null },
      decision: verdict
        ? buildDecisionDetail(verdict.kind === "model" ? verdict : null, verdict.kind === "tool" ? verdict : null)
        : undefined,
      status: "success",
    }));
  } catch (error) {
    // log may not be in scope here; fail silently.
  }
}

/**
 * Reasoning for one request, or null when the router leaves the client's thinking
 * alone. Whoever pays for the decision decides:
 *
 *   1. `x-red-router-reasoning: off`      → null, the client's own config is kept.
 *   2. `x-red-router-reasoning: <level>`  → that level (cause "header").
 *   3. hint `effort=<level>`              → that level (cause "hint"), no jev call.
 *   4. `x-red-router-reasoning: auto`     → the autopilot, enforced for this request
 *      even when the configured mode is off or the key is not covered.
 *   5. otherwise the configured autopilot, when it covers the key or combo.
 *
 * Deliberation comes from the auto-combo decision or the hint when either has one;
 * otherwise one noul question is asked per human turn, and only at the turn's first
 * request, since the level holds through the turn's tool loop.
 *
 * @returns {Promise<null|{mode:string, level:string, cause:string, from:string|null,
 *   deliberation:number|null, target:null|{mode:"set", level:string}}>}
 */
export async function planReasoning({ body, settings, apiKey = null, apiKeyId = null, comboName = null, sessionId = null, headers = null, userAgent = "", deliberation = null, hint = null, model = null, log }) {
  const override = parseReasoningHeader(headers?.[REASONING_HEADER]);
  if (override?.mode === "off") return null;
  if (override?.mode === "force") {
    log?.info?.("REASONING", `forced ${override.level} by header`);
    return { mode: "enforce", level: override.level, cause: "header", from: null, deliberation: null, target: { mode: "set", level: override.level } };
  }
  const effort = hintEffort(hint);
  if (effort) {
    log?.info?.("REASONING", `forced ${effort} by hint`);
    return { mode: "enforce", level: effort, cause: "hint", from: null, deliberation: null, target: { mode: "set", level: effort } };
  }

  const configured = normalizeAutopilotConfig(settings?.reasoningAutopilot);
  const requested = override?.mode === "auto";
  if (!requested && !autopilotApplies(configured, { apiKeyId, comboName })) return null;
  const config = requested ? { ...configured, mode: "enforce" } : configured;

  const signals = extractSignals(body, { userAgent, hint });
  const key = createHash("sha256").update(`${apiKey || "local"}:${sessionId || "ephemeral"}`).digest("hex").slice(0, 24);
  const session = reasoningSessions.read(key);
  const turnId = createHash("sha256").update(`${signals.humanTurns}:${signals.humanText || ""}`).digest("hex").slice(0, 16);
  const withinTurn = session?.state?.humanTurn === turnId;

  let measured = typeof deliberation === "number" ? deliberation : null;
  let response = null;
  let target = null;
  const wantsJev = measured === null && !withinTurn && !signals.housekeeping && !signals.encryptedTask && config.askJevDirect;
  if (wantsJev) {
    if (session?.memo?.hash === turnId) {
      measured = session.memo.deliberation;
    } else {
      const decisionConfig = { ...normalizeDecisionConfig(settings?.decisionRouter), ...(config.provider ? { provider: config.provider } : {}), timeoutMs: config.timeoutMs };
      target = await resolveDecisionTarget(decisionConfig, { apiKey, log });
      if (target) {
        const { questions } = buildReasoningQuestions();
        const state = buildState(body, { maxStateChars: 24000, dropSystem: signals.harnessSystem });
        response = await ask(target, decisionConfig, state, questions, log);
        const answer = response?.answers?.[DELIBERATION_KEY];
        measured = answer?.type === "noul" && Number.isFinite(answer.noul) ? answer.noul : null;
      }
    }
  }

  const result = decideReasoningLevel({
    signals,
    deliberation: measured,
    // No answer from jev: keep the level the session already has rather than guess,
    // and only on a session's first turn fall back to the deterministic score.
    jevFailed: wantsJev && measured === null,
    localDeliberation: wantsJev && measured === null ? localDeliberation(signals).score : null,
    turnId,
    contextWindow: model ? modelContextWindow(model) : null,
    previous: session?.state || null,
    config,
  });
  const memo = measured !== null && typeof deliberation !== "number" ? { hash: turnId, deliberation: measured } : session?.memo || null;
  if (result.state || memo) reasoningSessions.write(key, { state: result.state, memo });

  const verdict = { kind: "reasoning", mode: config.mode, requested, level: result.level, from: result.from, cause: result.cause, deliberation: measured, signals: signalsMeta(signals) };
  if (response) await recordUsage({ response, log, target, verdict });
  log?.info?.("REASONING", `${result.from || "-"}→${result.level} (${result.cause}${measured !== null ? `, deliberar ${fmt(measured)}` : ""}${requested ? ", auto" : ""}${config.mode === "shadow" ? ", shadow" : ""})`);

  return {
    mode: config.mode,
    level: result.level,
    cause: result.cause,
    from: result.from,
    deliberation: measured,
    target: config.mode === "enforce" ? { mode: "set", level: result.level } : null,
  };
}

/** A bounded in-process map whose entries expire with the session TTL. Routing
 *  state stays in-process, like comboRotationState; move it to the shared store
 *  together with them if routing state becomes distributed. */
function sessionStore(max) {
  const entries = new Map();
  return {
    read(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= Date.now()) {
        entries.delete(key);
        return null;
      }
      return entry.value;
    },
    write(key, value) {
      if (!key) return;
      if (!entries.has(key) && entries.size >= max) entries.delete(entries.keys().next().value);
      entries.delete(key);
      entries.set(key, { value, expiresAt: Date.now() + MEMORY_CONFIG.sessionTtlMs });
    },
    delete(key) {
      entries.delete(key);
    },
    clear() {
      entries.clear();
    },
  };
}

const reasoningSessions = sessionStore(5000);

export function resetReasoningSessions() {
  reasoningSessions.clear();
}

/** The last verdict per conversation and combo, so a repeated answer can unlock
 *  the ambiguous band without one conversation influencing another. Entries use
 *  the session-store TTL. This remains in-process, like comboRotationState; move
 *  both to the shared store together if routing state becomes distributed. */
const lastVerdicts = sessionStore(5000);

export function readPreviousVerdict(key) {
  return lastVerdicts.read(key)?.model || null;
}

export function rememberVerdict(key, decision) {
  if (!key) return;
  if (!decision?.model) {
    lastVerdicts.delete(key);
    return;
  }
  lastVerdicts.write(key, { model: decision.model });
}

export function resetVerdicts() {
  lastVerdicts.clear();
}

/**
 * What a decision row records about itself. Small and flat: it lands in a JSON column
 * read per row, so it carries the answer and the reason, never the whole pool.
 */
/** Which deterministic signal forced deliberation, for the decision log. */
function deliberationCause(signals) {
  if (signals?.stall) return "stall";
  if (signals?.planMode) return "plan_mode";
  return null;
}

function verdictMeta(decision, extra = {}) {
  if (!decision) return undefined;
  const round = (v) => (typeof v === "number" ? Number(v.toFixed(3)) : null);
  return {
    ...extra,
    apply: decision.apply === true,
    reason: decision.reason || null,
    model: decision.model || null,
    // Set when the cost tie-break moved the pick off jev's own answer, so a
    // cheaper route can still be traced to the verdict it came from.
    downgradedFrom: decision.downgradedFrom || null,
    tool: decision.tool || null,
    mode: decision.mode || null,
    confidence: round(decision.confidence),
    deliberation: round(decision.deliberation),
    cause: decision.cause || null,
    signals: decision.signals || null,
    ...(decision.deliberationSource ? { deliberationSource: decision.deliberationSource } : {}),
  };
}

const fmt = (n) => (typeof n === "number" ? n.toFixed(2) : "-");
