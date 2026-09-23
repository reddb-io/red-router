/**
 * Shared combo (model combo) handling with fallback support
 */

import { checkFallbackError } from "./accountFallback.js";
import { errorResponse } from "../utils/error.js";
import { getCapabilitiesForModel } from "../providers/capabilities.js";
import { getThinkingLevels } from "../providers/thinkingLevels.js";
import { stripThinkingSuffix } from "../translator/concerns/thinkingUnified.js";
import { extractTextContent } from "../translator/formats/gemini.js";
import { getSessionMember, rememberSessionMember, forgetSessionMember, preferSessionMember } from "./sessionAffinity.js";

// Hard capabilities = input modalities; missing one drops request data (e.g. image
// stripped). Must be prioritized. Soft (e.g. search) only degrades a feature.
const HARD_CAPS = new Set(["vision", "pdf", "audioInput", "videoInput"]);

// Prefixes used when flattening tool turns into plain prose for panel models.
const TOOL_CALL_PREFIX = "[Called tools: ";
const TOOL_RESULT_PREFIX = "[Tool result: ";

// Flatten tool turns into prose so panel models keep the context but can't loop
// on tools: drop the request's tools, turn tool/function results into assistant
// text, and inline assistant tool_calls names instead of the structured field.
function flattenToolHistory(messages) {
  return messages
    .filter((msg) => msg)
    .map((msg) => {
      if (msg.role === "tool" || msg.role === "function") {
        return { role: "assistant", content: `${TOOL_RESULT_PREFIX}${extractTextContent(msg.content) || String(msg.content ?? "")}]` };
      }
      if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
        const { tool_calls, ...rest } = msg;
        const names = tool_calls.map((c) => c?.function?.name || c?.name || "tool").join(", ");
        const base = extractTextContent(rest.content) || (typeof rest.content === "string" ? rest.content : "");
        return { ...rest, content: `${base}${base ? "\n" : ""}${TOOL_CALL_PREFIX}${names}]` };
      }
      if (Array.isArray(msg.content)) {
        const hasToolUse = msg.content.some((c) => c.type === "tool_use");
        const hasToolResult = msg.content.some((c) => c.type === "tool_result");
        if (hasToolUse || hasToolResult) {
          const textParts = [];
          const toolNames = [];
          const toolResults = [];
          for (const block of msg.content) {
            if (block.type === "text" && block.text) textParts.push(block.text);
            if (block.type === "tool_use") toolNames.push(block.name || "tool");
            if (block.type === "tool_result") toolResults.push(extractTextContent(block.content) || String(block.content ?? ""));
          }
          const { ...rest } = msg;
          let newContent = textParts.join("\n");
          if (toolNames.length > 0) {
            newContent = `${newContent}${newContent ? "\n" : ""}${TOOL_CALL_PREFIX}${toolNames.join(", ")}]`;
          }
          if (toolResults.length > 0) {
            newContent = `${newContent}${newContent ? "\n" : ""}${TOOL_RESULT_PREFIX}${toolResults.join("\n")}]`;
          }
          return { ...rest, content: newContent };
        }
      }
      return msg;
    });
}

// Reorder combo models by capability fit. Stable; never drops a model (fallback intact).
// Tier 0: satisfies all hard + all soft. Tier 1: all hard only. Tier 2: rest.
export function reorderByCapabilities(models, required) {
  if (!required || required.size === 0 || !Array.isArray(models) || models.length <= 1) return models;
  const hard = [...required].filter((c) => HARD_CAPS.has(c));
  const soft = [...required].filter((c) => !HARD_CAPS.has(c));

  const tierOf = (m) => {
    const slash = typeof m === "string" ? m.indexOf("/") : -1;
    const provider = slash > 0 ? m.slice(0, slash) : "";
    const model = slash > 0 ? m.slice(slash + 1) : m;
    // Members may carry a thinking suffix ("model(high)") — resolve via clean id.
    const caps = getCapabilitiesForModel(provider, stripThinkingSuffix(model));
    if (!hard.every((c) => caps[c] === true)) return 2;
    return soft.every((c) => caps[c] === true) ? 0 : 1;
  };

  // Stable sort by tier (Array.prototype.sort is stable in modern engines).
  const reordered = models
    .map((m, i) => ({ m, i, t: tierOf(m) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.m);
  return reordered.every((model, index) => model === models[index]) ? models : reordered;
}

/**
 * Reorder combo models so the model chosen for a complexity tier leads.
 *
 * Pure + network-free (unit-testable). The rest of the combo keeps its existing
 * order as the fallback ladder, so the availability/quota path is untouched — we
 * only change which model is tried FIRST.
 *
 * tierMap is an explicit per-combo policy: { SIMPLE, MEDIUM, COMPLEX, REASONING }
 * → model string (see config/jev.js). Resolution:
 *   - candidate already in models → stable-move to front (rest keep order);
 *   - candidate is a new model string → prepend it (primary), rest stay as fallback;
 *   - no candidate for the tier → models unchanged (fail-open).
 *
 * Capability auto-switch (reorderByCapabilities) runs AFTER this in handleComboChat,
 * so a hard capability (vision/pdf) still outranks a tier preference — correct
 * precedence, since picking a non-vision model would drop image data.
 *
 * @param {string[]} models - combo models (ordered fallback chain)
 * @param {string} tier - one of JEV_TIERS
 * @param {Record<string,string>} [tierMap] - tier → model policy
 * @returns {string[]} reordered models (never drops a model)
 */
export function reorderModelsForTier(models, tier, tierMap) {
  if (!Array.isArray(models) || models.length === 0 || !tier || !tierMap) return models;
  const candidate = tierMap[tier];
  if (typeof candidate !== "string" || !candidate.trim()) return models;

  const idx = models.indexOf(candidate);
  if (idx === 0) return models;                 // already leads
  if (idx > 0) {                                // stable-move to front
    const rest = models.filter((_, i) => i !== idx);
    return [candidate, ...rest];
  }
  return [candidate, ...models];                // new primary, rest as fallback
}

// Every combo strategy the chat path understands. Unknown values behave as "fallback".
export const COMBO_STRATEGIES = ["fallback", "round-robin", "fusion", "smart", "auto"];

/** The strategy a combo runs with: its own override, else the global default. */
export function comboStrategyFor(settings, comboName) {
  return settings?.comboStrategies?.[comboName]?.fallbackStrategy || settings?.comboStrategy || "fallback";
}

/**
 * Track rotation state per combo (for round-robin strategy)
 * @type {Map<string, { index: number, consecutiveUseCount: number }>}
 */
const comboRotationState = new Map();

// Trailing run of items after the last assistant/model turn = the current user
// turn. It may span several messages (e.g. text + image split across blocks),
// so we return all of them. History media (older turns) must not pin the combo
// to a vision model — those get stripped + placeholdered downstream instead.
export function trailingUserItems(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  const isAssistant = (r) => r === "assistant" || r === "model";
  let i = arr.length - 1;
  while (i >= 0 && !isAssistant(arr[i]?.role)) i--;
  return arr.slice(i + 1);
}

// Detect which capabilities a request needs. Modalities (vision/pdf) are scanned
// only on the current user turn; "search" is request-wide (lives in tools).
// Returns a Set of: "vision" | "pdf" | "search".
export function detectRequiredCapabilities(body) {
  const required = new Set();
  if (!body || typeof body !== "object") return required;

  const addByMime = (mime) => {
    if (typeof mime !== "string") return;
    if (mime.startsWith("image/")) required.add("vision");
    else if (mime === "application/pdf") required.add("pdf");
    else if (mime.startsWith("audio/")) required.add("audioInput");
    else if (mime.startsWith("video/")) required.add("videoInput");
  };

  const scanBlock = (b) => {
    if (!b || typeof b !== "object") return;
    const t = b.type;
    if (t === "image_url" || t === "image" || t === "input_image") required.add("vision");
    if (t === "input_audio" || t === "audio_url" || t === "audio") required.add("audioInput");
    if (t === "input_video" || t === "video_url" || t === "video") required.add("videoInput");
    if (t === "file" || t === "document" || t === "input_file") {
      // Infer modality from embedded mime when available; fall back to pdf for generic files.
      let fmime = null;
      if (b.input_audio?.format) fmime = `audio/${b.input_audio.format}`;
      else if (b.file?.file_data) fmime = String(b.file.file_data).match(/^data:([^;,]+)/)?.[1];
      else if (b.source?.media_type) fmime = b.source.media_type;
      else if (b.source?.data) fmime = String(b.source.data).match(/^data:([^;,]+)/)?.[1];
      if (fmime) addByMime(fmime);
      else required.add("pdf");
    }
    // gemini parts: inlineData/fileData carry a mime
    addByMime(b.inlineData?.mimeType || b.fileData?.mimeType);
  };

  const scanContent = (content) => {
    if (Array.isArray(content)) for (const b of content) scanBlock(b);
  };

  const scanMessage = (m) => {
    if (!m || typeof m !== "object") return;

    // Ollama / Hermes images array (strings or objects)
    if (Array.isArray(m.images) && m.images.length > 0) {
      required.add("vision");
    }

    // Vercel AI SDK / Hermes attachments / experimental_attachments
    const attachments = m.experimental_attachments || m.attachments;
    if (Array.isArray(attachments)) {
      for (const att of attachments) {
        if (!att) continue;
        const mime = att.contentType || att.mediaType || (typeof att.url === "string" && att.url.match(/^data:([^;,]+)/)?.[1]);
        if (mime) addByMime(mime);
        else if (att.url || att.data) required.add("vision");
      }
    }

    // Direct message-level modality properties
    if (m.image_url || m.image) required.add("vision");
    if (m.audio_url || m.audio) required.add("audioInput");

    // Scan array content blocks
    scanContent(m.content);

    // Scan string content for embedded data URIs
    if (typeof m.content === "string") {
      if (m.content.includes("data:image/")) required.add("vision");
      else if (m.content.includes("data:audio/")) required.add("audioInput");
      else if (m.content.includes("data:application/pdf")) required.add("pdf");
    }
  };

  // Modalities: current user turn only (trailing user run across each known shape).
  for (const m of trailingUserItems(body.messages)) scanMessage(m);              // openai / claude / hermes / ollama
  for (const it of trailingUserItems(body.input)) scanContent(it.content);       // responses
  const contents = body.contents || body.request?.contents;                      // gemini / antigravity
  for (const c of trailingUserItems(contents)) scanContent(c.parts);

  // Search is request-wide and may be represented as a hosted tool type, a
  // named tool, or an OpenAI function tool depending on the client.
  const tools = [body.tools, body.request?.tools].filter(Array.isArray).flat();
  for (const tool of tools) {
    const type = String(tool?.type || "").toLowerCase();
    const name = String(tool?.name || tool?.function?.name || "").toLowerCase();
    if (type === "web_search" || type.startsWith("web_search_") || name === "web_search" || name.startsWith("web_search_")) {
      required.add("search");
      break;
    }
  }

  return required;
}

function normalizeStickyLimit(stickyLimit) {
  const parsed = Number.parseInt(stickyLimit, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

// ── Context-aware rotation (ghcr.io/reddb-io/red-router#1089) ─────────────────────────
//
// A combo must not spend a rotation slot on a member whose context window
// cannot hold the request: that attempt fails, the combo falls through, and
// the retry latency the combo exists to avoid is paid anyway. Estimate the
// request size, drop members whose window is smaller, and fail fast with a
// clear error when no member can hold it.

// Fixed token cost of a media block. The real cost varies by resolution and
// provider; these are generous placeholders so a request carrying media is not
// routed into a window it overflows once the provider bills the content.
const MEDIA_TOKEN_COSTS = { image: 1500, pdf: 4000, audio: 1200, video: 6000 };

// 4 characters ≈ 1 token for the text the request carries.
function charsToTokens(chars) {
  return Math.ceil(chars / 4);
}

function textTokens(value) {
  return typeof value === "string" ? charsToTokens(value.length) : 0;
}

// Text size of one content value: a string, or the block shapes the
// OpenAI/Claude/Gemini translators see (text, tool results, media, files).
function contentTokens(content) {
  if (typeof content === "string") return charsToTokens(content.length);
  if (!Array.isArray(content)) return 0;
  let tokens = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    tokens += textTokens(block.text) + textTokens(block.content) + textTokens(block.input);
    const type = block.type;
    if (type === "image_url" || type === "image" || type === "input_image") tokens += MEDIA_TOKEN_COSTS.image;
    else if (type === "input_audio" || type === "audio") tokens += MEDIA_TOKEN_COSTS.audio;
    else if (type === "input_video" || type === "video" || type === "video_url") tokens += MEDIA_TOKEN_COSTS.video;
    else if (type === "document" || type === "file" || type === "input_file") tokens += MEDIA_TOKEN_COSTS.pdf;
    if (block.inlineData || block.fileData) tokens += MEDIA_TOKEN_COSTS.image;
  }
  return tokens;
}

// Rough request size in tokens: system plus every message shape the chat
// handlers translate (OpenAI messages, Responses input, Gemini contents) plus
// tool schemas. An estimate, not an exact count: the combo only needs to know
// which members clearly cannot hold the request.
export function estimateRequestTokens(body) {
  if (!body || typeof body !== "object") return 0;
  let tokens = Array.isArray(body.system) ? contentTokens(body.system) : textTokens(body.system);
  for (const message of body.messages ?? []) {
    if (!message || typeof message !== "object") continue;
    tokens += contentTokens(message.content);
    if (Array.isArray(message.images)) tokens += MEDIA_TOKEN_COSTS.image * message.images.length;
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        tokens += textTokens(JSON.stringify(call?.function?.arguments ?? ""));
      }
    }
  }
  for (const item of body.input ?? []) {
    if (item && typeof item === "object") tokens += contentTokens(item.content);
  }
  for (const turn of body.contents ?? []) {
    if (!turn || typeof turn !== "object") continue;
    for (const part of turn.parts ?? []) {
      if (!part || typeof part !== "object") continue;
      tokens += textTokens(part.text);
      if (part.inlineData || part.fileData) tokens += MEDIA_TOKEN_COSTS.image;
    }
  }
  if (Array.isArray(body.tools)) tokens += charsToTokens(JSON.stringify(body.tools).length);
  return tokens;
}

// Largest output the request asks for: a member must fit input plus output
// within its window, which bills both.
function requestedOutputTokens(body) {
  const candidates = [
    body?.max_tokens,
    body?.max_completion_tokens,
    body?.max_output_tokens,
    body?.generationConfig?.maxOutputTokens,
  ];
  return Math.max(0, ...candidates.filter((n) => Number.isFinite(n) && n > 0));
}

// Context window of a "provider/model" combo member through the shared
// capability tables (hand-written patterns plus the models.dev sync). Always
// finite in practice: unknown members resolve to the default window and stay
// in the rotation.
export function modelContextWindow(modelStr) {
  const slash = typeof modelStr === "string" ? modelStr.indexOf("/") : -1;
  // Members may carry a thinking suffix ("model(high)") — resolve via clean id.
  const caps = getCapabilitiesForModel(
    slash > 0 ? modelStr.slice(0, slash) : "",
    stripThinkingSuffix(slash > 0 ? modelStr.slice(slash + 1) : modelStr)
  );
  return Number.isFinite(caps?.contextWindow) ? caps.contextWindow : null;
}

// Split the rotation into members that can hold the request and members that
// clearly cannot (their whole window is smaller than the request, so every
// attempt is wasted). Order is preserved for the members kept.
export function filterModelsByContext(models, body) {
  const kept = Array.isArray(models) ? models : [];
  const needed = estimateRequestTokens(body) + requestedOutputTokens(body);
  if (needed <= 0 || kept.length === 0) return { models: kept, skipped: [], needed: 0 };
  const fits = [];
  const skipped = [];
  for (const model of kept) {
    const context = modelContextWindow(model);
    if (context === null || needed <= context) fits.push(model);
    else skipped.push({ model, context });
  }
  return { models: fits, skipped, needed };
}

// Clear 400 instead of looping through members that cannot fit: name each
// member's window so the user can fix the combo or trim the conversation.
export function contextOverflowResponse(comboName, filter) {
  const windows = filter.skipped.map((s) => `${s.model} (${s.context})`).join(", ");
  return new Response(
    JSON.stringify({
      error: {
        message:
          `Combo "${comboName}" cannot hold this request (~${filter.needed} tokens). ` +
          `Every member's context is smaller: ${windows}. ` +
          `Trim the conversation or give the combo larger-context models.`,
        type: "invalid_request_error",
      },
    }),
    { status: 400, headers: { "Content-Type": "application/json" } }
  );
}

function rotateModelsFromIndex(models, currentIndex) {
  const rotatedModels = [...models];
  for (let i = 0; i < currentIndex; i++) {
    const moved = rotatedModels.shift();
    rotatedModels.push(moved);
  }
  return rotatedModels;
}

/**
 * Get rotated model list based on strategy
 * @param {string[]} models - Array of model strings
 * @param {string} comboName - Name of the combo
 * @param {string} strategy - "fallback" or "round-robin"
 * @param {number|string} [stickyLimit=1] - Requests per combo model before switching
 * @returns {string[]} Rotated models array
 */
export function getRotatedModels(models, comboName, strategy, stickyLimit = 1) {
  if (!models || models.length <= 1 || strategy !== "round-robin") {
    return models;
  }

  const rotationKey = comboName || "__default__";
  const normalizedStickyLimit = normalizeStickyLimit(stickyLimit);
  const existingState = comboRotationState.get(rotationKey);
  const state = typeof existingState === "number"
    ? { index: existingState, consecutiveUseCount: 0 }
    : (existingState || { index: 0, consecutiveUseCount: 0 });

  const currentIndex = state.index % models.length;
  const rotatedModels = rotateModelsFromIndex(models, currentIndex);
  const nextUseCount = state.consecutiveUseCount + 1;

  if (nextUseCount >= normalizedStickyLimit) {
    comboRotationState.set(rotationKey, {
      index: (currentIndex + 1) % models.length,
      consecutiveUseCount: 0,
    });
  } else {
    comboRotationState.set(rotationKey, {
      index: currentIndex,
      consecutiveUseCount: nextUseCount,
    });
  }

  return rotatedModels;
}

/**
 * Reset in-memory rotation state when combo/settings change
 * @param {string} [comboName] - Combo name to reset; omit to clear all
 */
export function resetComboRotation(comboName) {
  if (comboName) comboRotationState.delete(comboName);
  else comboRotationState.clear();
}

/**
 * Get combo models from combos data
 * @param {string} modelStr - Model string to check
 * @param {Array|Object} combosData - Array of combos or object with combos
 * @returns {string[]|null} Array of models or null if not a combo
 */
export function getComboModelsFromData(modelStr, combosData) {
  // Don't check if it's in provider/model format
  if (modelStr.includes("/")) return null;
  
  // Handle both array and object formats
  const combos = Array.isArray(combosData) ? combosData : (combosData?.combos || []);
  
  const combo = combos.find(c => c.name === modelStr);
  if (combo && combo.models && combo.models.length > 0) {
    return combo.models;
  }
  return null;
}

// Re-attach a combo-level thinking suffix ("(high)", "(8192)") to members that
// do not carry their own — a member-specific suffix always wins over the one
// requested on the combo name.
export function withThinkingSuffix(models, suffix) {
  return (Array.isArray(models) ? models : []).map((id) => (
    typeof id === "string" && /\([^()]*\)\s*$/.test(id.trim()) ? id : `${id}${suffix}`
  ));
}

// Combo names may carry a thinking override suffix ("my-combo(high)"). Combo
// resolution is by exact name, so parse/strip the suffix before lookup and
// re-attach it to every member — applyThinking then applies and clamps it
// per member via parseSuffix.
export function resolveComboRequest(modelStr, combosData) {
  const exact = getComboModelsFromData(modelStr, combosData);
  if (exact) return { models: exact, comboName: modelStr, suffix: "" };
  const match = typeof modelStr === "string" ? modelStr.match(/^(.*)\(([^()]+)\)\s*$/) : null;
  if (!match) return null;
  const comboName = match[1].trim();
  const models = getComboModelsFromData(comboName, combosData);
  if (!models) return null;
  const suffix = `(${match[2]})`;
  return { models: withThinkingSuffix(models, suffix), comboName, suffix };
}

// Thinking levels a combo can honor: the intersection across members (weakest
// member rule, same doctrine as the combo context limits). Any member without
// reasoning support makes the combo expose no levels — routing to it with a
// level request would silently drop the override.
export function comboThinkingLevels(members) {
  const list = Array.isArray(members) ? members : [];
  if (list.length === 0) return null;
  let levels = null;
  for (const member of list) {
    if (typeof member !== "string" || !member.trim()) continue;
    const slash = member.indexOf("/");
    const provider = slash > 0 ? member.slice(0, slash) : "";
    const model = stripThinkingSuffix(slash > 0 ? member.slice(slash + 1) : member);
    const memberLevels = getThinkingLevels(provider, model);
    if (!memberLevels || memberLevels.length === 0) return null;
    if (!levels) {
      levels = [...memberLevels];
      continue;
    }
    levels = levels.filter((l) => memberLevels.includes(l));
    if (levels.length === 0) return null;
  }
  return levels;
}

/**
 * Handle combo chat with fallback
 * @param {Object} options
 * @param {Object} options.body - Request body
 * @param {string[]} options.models - Array of model strings to try
 * @param {Function} options.handleSingleModel - Function to handle single model: (body, modelStr) => Promise<Response>
 * @param {Object} options.log - Logger object
 * @param {string} [options.comboName] - Name of the combo (for round-robin tracking)
 * @param {string} [options.comboStrategy] - Strategy: "fallback" or "round-robin"
 * @param {number|string} [options.comboStickyLimit=1] - Requests per combo model before switching
 * @param {string|null} [options.sessionKey] - Session affinity key; the member that last
 *   served it leads (round-robin does not advance), and each success is remembered
 * @param {boolean} [options.routedLead=false] - This request's lead was chosen by the
 *   combo's own routing (a smart tier or an applied auto decision); it outranks the
 *   remembered member, and the member that serves is remembered as usual
 * @returns {Promise<Response>}
 */
export async function handleComboChat({ body, models, handleSingleModel, log, comboName, comboStrategy, comboStickyLimit = 1, autoSwitch = true, errorContext = {}, sessionKey = null, routedLead = false }) {
  const sessionMember = sessionKey && !routedLead ? getSessionMember(comboName, sessionKey) : null;
  const stickyMember = sessionMember && Array.isArray(models) && models.includes(sessionMember) ? sessionMember : null;
  let rotatedModels = stickyMember
    ? preferSessionMember(models, stickyMember)
    : getRotatedModels(models, comboName, comboStrategy, comboStickyLimit);
  if (stickyMember) log.info("COMBO", `session affinity → ${stickyMember}`);
  // A member that fails stops being the session's preference; the next success
  // replaces it.
  const forget = (modelStr) => {
    if (sessionKey) forgetSessionMember(comboName, sessionKey, modelStr);
  };

  if (autoSwitch) {
    const required = detectRequiredCapabilities(body);
    if (required.size > 0) {
      const reordered = reorderByCapabilities(rotatedModels, required);
      if (reordered[0] !== rotatedModels[0]) {
        log.info("COMBO", `auto-switch for [${[...required].join(",")}] → ${reordered[0]}`);
      }
      rotatedModels = reordered;
    }
  }

  // Skip members whose context window cannot hold the request, and fail fast
  // with a clear error when no member can — instead of burning a rotation slot
  // (and a provider round-trip) on a member that is guaranteed to overflow.
  const contextFilter = filterModelsByContext(rotatedModels, body);
  for (const skip of contextFilter.skipped) {
    log.info("COMBO", `Skipping ${skip.model} (context ${skip.context} < ~${contextFilter.needed} request tokens)`);
  }
  if (contextFilter.skipped.length > 0 && contextFilter.models.length === 0) {
    log.warn("COMBO", `All ${rotatedModels.length} combo members too small for ~${contextFilter.needed} request tokens`);
    return contextOverflowResponse(comboName, contextFilter);
  }
  rotatedModels = contextFilter.models;

  let bestRetry = null;
  let firstFallbackError = null;
  let noCredentialsCount = 0;

  for (let i = 0; i < rotatedModels.length; i++) {
    const modelStr = rotatedModels[i];
    log.info("COMBO", `Trying model ${i + 1}/${rotatedModels.length}: ${modelStr}`);

    try {
      const result = await handleSingleModel(body, modelStr);
      if (result.ok) {
        log.info("COMBO", `Model ${modelStr} succeeded`);
        if (sessionKey) rememberSessionMember(comboName, sessionKey, modelStr);
        return result;
      }

      const reason = result.headers.get("X-9Router-Reason");
      if (reason === "no_active_credentials") {
        forget(modelStr);
        noCredentialsCount++;
        log.warn("COMBO", `Model ${modelStr} skipped: no active credentials`);
        continue;
      }

      const retryAtMs = Date.parse(result.headers.get("X-9Router-Retry-At") || "");
      if (Number.isFinite(retryAtMs) && retryAtMs > Date.now() && (!bestRetry || retryAtMs < bestRetry.retryAtMs)) {
        bestRetry = { retryAtMs, response: result, index: i };
      }

      let errorText = result.statusText || "";
      try {
        const errorBody = await result.clone().json();
        errorText = errorBody?.error?.message || errorBody?.error || errorBody?.message || errorText;
      } catch {}
      if (typeof errorText !== "string") {
        try { errorText = JSON.stringify(errorText); } catch { errorText = String(errorText); }
      }

      const { shouldFallback, cooldownMs } = checkFallbackError(result.status, errorText);
      if (!shouldFallback) {
        log.warn("COMBO", `Model ${modelStr} failed (no fallback)`, { status: result.status });
        return result;
      }
      if (!firstFallbackError) firstFallbackError = result;
      forget(modelStr);

      if (cooldownMs > 0 && cooldownMs <= 5000 && [502, 503, 504].includes(result.status)) {
        log.info("COMBO", `Model ${modelStr} transient ${result.status}, waiting ${cooldownMs}ms before next`);
        await new Promise(resolve => setTimeout(resolve, cooldownMs));
      }
      log.warn("COMBO", `Model ${modelStr} failed, trying next`, { status: result.status });
    } catch (error) {
      forget(modelStr);
      log.warn("COMBO", `Model ${modelStr} threw error, trying next`, { error: error.message || String(error) });
    }
  }

  if (bestRetry) return bestRetry.response;
  if (firstFallbackError) return firstFallbackError;

  const allMissing = rotatedModels.length > 0 && noCredentialsCount === rotatedModels.length;
  const message = allMissing ? `No active credentials for combo: ${comboName || "unknown"}` : "All combo models unavailable";
  log.warn("COMBO", `All models failed | ${message}`);
  return errorResponse(503, message, {
    ...errorContext,
    reason: allMissing ? "no_active_credentials" : "temporarily_unavailable",
    retryable: !allMissing,
  });
}
/**
 * Extract assistant text from a non-stream completion across formats
 * (OpenAI chat, Claude messages, Gemini, OpenAI Responses). Returns "" if none.
 * Panel responses are already translated to the client format by chatCore, so the
 * leaf content→string step reuses the translator's own extractTextContent.
 */
function extractPanelText(json) {
  if (!json || typeof json !== "object") return "";

  // OpenAI chat completion
  const choice = json.choices?.[0];
  if (choice) {
    const msg = choice.message ?? choice.delta ?? {};
    const t = extractTextContent(msg.content);
    if (t.trim()) return t;
    if (typeof choice.text === "string" && choice.text.trim()) return choice.text;
  }

  // Claude messages (text blocks share OpenAI's {type:"text"} shape)
  const claudeText = extractTextContent(json.content);
  if (claudeText.trim()) return claudeText;

  // Gemini (parts carry .text without a type discriminator)
  const parts = json.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    const t = parts.map((p) => p?.text || "").join("");
    if (t.trim()) return t;
  }

  // OpenAI Responses API
  if (Array.isArray(json.output)) {
    const t = json.output
      .flatMap((o) => (Array.isArray(o.content) ? o.content.map((c) => c?.text || "") : []))
      .join("");
    if (t.trim()) return t;
  }

  return "";
}

/**
 * Append a synthesized user turn to whichever message array the request format uses.
 * Preserves the original conversation + system prompt so the judge has full context.
 */
function appendUserTurn(body, text) {
  const next = { ...body };
  if (Array.isArray(body.messages)) {
    next.messages = [...body.messages, { role: "user", content: text }];
  } else if (Array.isArray(body.input)) {
    next.input = [...body.input, { role: "user", content: text }];
  } else if (Array.isArray(body.contents)) {
    next.contents = [...body.contents, { role: "user", parts: [{ text }] }];
  } else {
    next.messages = [{ role: "user", content: text }];
  }
  return next;
}

/**
 * Build the judge directive. Per OpenRouter's Fusion design, the judge does NOT
 * merge — it analyzes (consensus / contradictions / partial coverage / unique
 * insights / blind spots) then writes one answer grounded in that analysis.
 * ~3/4 of fusion's quality lift comes from this synthesis step.
 *
 * Sources are anonymized ("Source N") so the judge weighs substance, not the
 * reputation of a model brand.
 */
function buildJudgePrompt(answers) {
  const panel = answers
    .map((a, i) => `[Source ${i + 1}]\n${a.text}`)
    .join("\n\n");

  return [
    `You are the JUDGE in a model-fusion panel. ${answers.length} expert models independently answered the user's most recent request. Their responses are below, anonymized by source.`,
    "",
    "Do NOT mention that multiple models were used, and do NOT refer to the sources. Produce ONE authoritative final answer addressed directly to the user.",
    "",
    "First, internally analyze the panel along these dimensions: consensus (points most sources agree on — treat as higher-confidence), contradictions (where they disagree — resolve with your own judgment), partial coverage, unique insights only one source surfaced, and blind spots every source missed. Then write the best possible final answer grounded in that analysis — more complete and correct than any single response, with no filler.",
    "",
    "=== PANEL RESPONSES ===",
    panel,
    "=== END PANEL RESPONSES ===",
    "",
    "Now write the final answer to the user's original request.",
  ].join("\n");
}

// Fusion tuning. Overridable per-combo via settings.comboStrategies[name].
const FUSION_DEFAULTS = {
  minPanel: 2,             // answers needed before stragglers get a grace window
  stragglerGraceMs: 8000,  // wait this long for laggards once quorum is reached
  panelHardTimeoutMs: 90000, // absolute cap so one hung model can't stall forever
};

// Resolve a Response (or {__error}) within ms; the loser keeps running but is ignored.
function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ __timeout: true }), ms);
    Promise.resolve(promise)
      .then((v) => { clearTimeout(t); resolve(v); })
      .catch((e) => { clearTimeout(t); resolve({ __error: e }); });
  });
}

/**
 * Collect panel responses with quorum-grace: as soon as `minPanel` calls succeed,
 * start a short grace timer for the rest, then proceed with whatever arrived. This
 * caps the straggler penalty (the slowest model otherwise dominates wall time) while
 * still preferring a full panel when everyone is fast. Bounded by a hard timeout.
 * Returns a sparse array aligned to `calls` (undefined = not yet / dropped).
 */
function collectPanel(calls, { minPanel, stragglerGraceMs, panelHardTimeoutMs }) {
  return new Promise((resolve) => {
    const out = new Array(calls.length);
    let settled = 0;
    let ok = 0;
    let finished = false;
    let graceTimer = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(hardTimer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve(out);
    };
    const hardTimer = setTimeout(finish, panelHardTimeoutMs);
    calls.forEach((p, i) => {
      Promise.resolve(p)
        .then((v) => { out[i] = v; })
        .catch((e) => { out[i] = { __error: e }; })
        .finally(() => {
          settled++;
          if (out[i] && out[i].ok) ok++;
          if (settled === calls.length) return finish();
          if (ok >= minPanel && !graceTimer) graceTimer = setTimeout(finish, stragglerGraceMs);
        });
    });
  });
}

function bestRetryResponse(responses) {
  let best = null;
  let firstError = null;
  let noCredentialsCount = 0;
  let responseCount = 0;
  for (let index = 0; index < responses.length; index++) {
    const response = responses[index];
    if (!(response instanceof Response) || response.ok) continue;
    responseCount++;
    const reason = response.headers.get("X-9Router-Reason");
    if (reason === "no_active_credentials") {
      noCredentialsCount++;
      continue;
    }
    if (!firstError) firstError = response;
    const retryAtMs = Date.parse(response.headers.get("X-9Router-Retry-At") || "");
    if (Number.isFinite(retryAtMs) && retryAtMs > Date.now() && (!best || retryAtMs < best.retryAtMs)) {
      best = { retryAtMs, response, index };
    }
  }
  return { response: best?.response || firstError, allMissing: responseCount > 0 && noCredentialsCount === responseCount };
}

/**
 * Handle a fusion combo: fan the prompt out to every panel model in parallel,
 * then a judge model synthesizes one final answer from all panel responses.
 *
 * Panel calls are forced non-streaming with tools stripped (the judge needs
 * complete prose to synthesize). The judge call keeps the client's original
 * stream flag + tools, so streaming and downstream tool use still work.
 *
 * Speed: quorum-grace collection caps the straggler penalty. Quality: the judge
 * runs the consensus/contradiction/blind-spot analysis before writing.
 *
 * Degrades gracefully: 0 panel answers -> 503, exactly 1 -> return it directly.
 *
 * @param {Object} options
 * @param {Object} options.body - Request body (client format)
 * @param {string[]} options.models - Panel model strings
 * @param {Function} options.handleSingleModel - (body, modelStr) => Promise<Response>
 * @param {Object} options.log - Logger
 * @param {string} [options.comboName] - Combo name (logging)
 * @param {string} [options.judgeModel] - Judge model; falls back to panel[0]
 * @param {Object} [options.tuning] - Override FUSION_DEFAULTS (minPanel, grace, timeout)
 * @returns {Promise<Response>}
 */
export async function handleFusionChat({ body, models, handleSingleModel, log, comboName, judgeModel, tuning, errorContext = {} }) {
  const panel = Array.isArray(models) ? models.filter(Boolean) : [];
  if (panel.length === 0) {
    return errorResponse(400, "Fusion combo has no models", errorContext);
  }

  // A single-model fusion has nothing to fuse — just answer directly.
  if (panel.length === 1) {
    return handleSingleModel(body, panel[0]);
  }

  const cfg = { ...FUSION_DEFAULTS, ...(tuning || {}) };
  const minPanel = Math.min(Math.max(2, cfg.minPanel), panel.length);
  const judge = judgeModel && judgeModel.trim() ? judgeModel.trim() : panel[0];
  log.info("FUSION", `Combo "${comboName}" | panel=${panel.length} [${panel.join(", ")}] | judge=${judge} | quorum=${minPanel}`);

  // 1. Fan out to the panel in parallel: non-streaming, tools stripped (we want prose).
  const { tools, tool_choice, stream_options, ...rest } = body;
  // Fusion runs panel models non-streaming; drop stream_options too, or providers
  // like DeepSeek reject it with "stream_options should be set along with stream = true".
  // See issue #3024.
  const panelBody = { ...rest, stream: false };

  // Flatten tool turns to prose so panel models keep context without emitting tool_calls.
  if (Array.isArray(panelBody.messages)) {
    panelBody.messages = flattenToolHistory(panelBody.messages);
  } else if (Array.isArray(panelBody.input)) {
    panelBody.input = flattenToolHistory(panelBody.input);
  }

  const t0 = Date.now();
  const calls = panel.map((m) => withTimeout(handleSingleModel(panelBody, m, true), cfg.panelHardTimeoutMs));
  const settled = await collectPanel(calls, { ...cfg, minPanel });
  log.info("FUSION", `fan-out collected in ${Date.now() - t0}ms`);

  // 2. Collect successful answers.
  const answers = [];
  const failedResponses = [];
  for (let i = 0; i < settled.length; i++) {
    const res = settled[i];
    const model = panel[i];
    if (!res) { log.warn("FUSION", `Panel ${model} dropped (straggler/timeout)`); continue; }
    if (res.__timeout) { log.warn("FUSION", `Panel ${model} timed out`); continue; }
    if (res.__error) { log.warn("FUSION", `Panel ${model} threw`, { error: res.__error?.message || String(res.__error) }); continue; }
    if (!res.ok) {
      failedResponses.push(res);
      log.warn("FUSION", `Panel ${model} failed`, { status: res.status });
      continue;
    }
    try {
      const json = await res.clone().json();
      const text = extractPanelText(json);
      if (text) {
        answers.push({ model, text });
        log.info("FUSION", `Panel ${model} ok (${text.length} chars)`);
      } else {
        log.warn("FUSION", `Panel ${model} returned empty content`);
      }
    } catch (e) {
      log.warn("FUSION", `Panel ${model} unparseable`, { error: e.message || String(e) });
    }
  }

  // 3. Degrade gracefully when the panel is too thin to fuse.
  if (answers.length === 0) {
    log.warn("FUSION", "All panel models failed");
    const failure = bestRetryResponse(failedResponses);
    if (failure.response) return failure.response;
    return errorResponse(503, "All fusion panel models failed", {
      ...errorContext,
      reason: failure.allMissing ? "no_active_credentials" : "temporarily_unavailable",
      retryable: !failure.allMissing,
    });
  }
  if (answers.length === 1) {
    log.info("FUSION", `Only ${answers[0].model} succeeded — answering directly (no fusion)`);
    return handleSingleModel(body, answers[0].model);
  }

  // 4. Judge analyzes + writes one final answer (streams to client if requested).
  const judgeBody = appendUserTurn(body, buildJudgePrompt(answers));
  log.info("FUSION", `Judging ${answers.length} answers with ${judge}`);
  return handleSingleModel(judgeBody, judge);
}
