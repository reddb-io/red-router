// Relevance compaction (opt-in token saver): old tool outputs the current request
// no longer needs are replaced by a one-line marker. Relevance is asked of the
// decision model (jev) as one `noul` question per tool output, in a single call,
// and each output is judged once: the score is cached by its tool call id.
//
// Fail-open like the rest of rtk/: no answer, a bad answer or any error leaves the
// body untouched. Never touched: error results (the trace matters), short outputs,
// the most recent exchanges, and outputs already compacted.

import { extractSignals } from "../decision/signals.js";

export const RELEVANCE_DEFAULTS = {
  threshold: 0.2,      // outputs scored below this are dropped
  minChars: 200,       // shorter outputs are cheaper to keep than to judge
  keepRecent: 2,       // the newest tool outputs are always kept
  maxQuestions: 8,     // outputs judged per request (the rest wait for later turns)
  snippetChars: 600,   // how much of each output the question quotes
};

const MARKER = "[RedRouter: tool output omitted as not relevant to the current request";
const CACHE_MAX = 5000;
const scoreCache = new Map(); // `${id}:${length}` -> 0..1

function remember(key, score) {
  if (scoreCache.size >= CACHE_MAX) scoreCache.delete(scoreCache.keys().next().value);
  scoreCache.set(key, score);
}

const textOfParts = (parts) => parts.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");

/**
 * Every tool output in the body with a way to replace it, in transcript order:
 * OpenAI `role:"tool"`, Claude `tool_result` blocks and Responses
 * `function_call_output`. Names come from the call that produced each output.
 */
export function collectToolOutputs(body) {
  const items = Array.isArray(body?.messages) ? body.messages : Array.isArray(body?.input) ? body.input : [];
  const calls = new Map();
  const outputs = [];
  for (const item of items) {
    if (!item) continue;
    for (const call of item.tool_calls || []) if (call?.id) calls.set(call.id, call.function?.name || "tool");
    if (Array.isArray(item.content)) {
      for (const block of item.content) if (block?.type === "tool_use" && block.id) calls.set(block.id, block.name || "tool");
    }
    if (item.type === "function_call" && item.call_id) calls.set(item.call_id, item.name || "tool");

    if (item.role === "tool" && item.tool_call_id) {
      const text = typeof item.content === "string" ? item.content : Array.isArray(item.content) ? textOfParts(item.content) : "";
      outputs.push({ id: item.tool_call_id, text, isError: false, replace: (marker) => { item.content = marker; } });
    } else if (item.type === "function_call_output" && item.call_id) {
      const text = typeof item.output === "string" ? item.output : Array.isArray(item.output) ? item.output.map((p) => p?.text || "").join("\n") : "";
      outputs.push({ id: item.call_id, text, isError: item.status === "error", replace: (marker) => { item.output = marker; } });
    } else if (Array.isArray(item.content)) {
      for (const block of item.content) {
        if (block?.type !== "tool_result" || !block.tool_use_id) continue;
        const text = typeof block.content === "string" ? block.content : Array.isArray(block.content) ? textOfParts(block.content) : "";
        outputs.push({ id: block.tool_use_id, text, isError: block.is_error === true, replace: (marker) => { block.content = marker; } });
      }
    }
  }
  return outputs.map((o) => ({ ...o, name: calls.get(o.id) || "tool" }));
}

/**
 * @param {object} body client body, compacted in place
 * @param {object} opts
 * @param {(state:string, questions:object) => Promise<object|null>} opts.ask returns jev answers or null
 * @returns {Promise<null|{judged:number, dropped:number, charsSaved:number}>}
 */
export async function compactByRelevance(body, { ask, log = null, ...overrides } = {}) {
  try {
    const cfg = { ...RELEVANCE_DEFAULTS, ...overrides };
    const outputs = collectToolOutputs(body);
    const older = outputs.slice(0, Math.max(0, outputs.length - cfg.keepRecent))
      .filter((o) => !o.isError && o.text.length >= cfg.minChars && !o.text.startsWith(MARKER));
    if (older.length === 0) return null;

    const request = extractSignals(body).humanText || "";
    if (!request) return null;

    const scores = new Map();
    const unjudged = [];
    for (const o of older) {
      const cached = scoreCache.get(`${o.id}:${o.text.length}`);
      if (typeof cached === "number") scores.set(o, cached);
      else if (unjudged.length < cfg.maxQuestions) unjudged.push(o);
    }

    if (unjudged.length) {
      const questions = {};
      unjudged.forEach((o, i) => {
        questions[`relevant_${i}`] = {
          type: "noul",
          instructions: `How much does answering the current request depend on this earlier output of the "${o.name}" tool? `
            + `0 = not at all, 1 = essential.\n---\n${o.text.slice(0, cfg.snippetChars)}`,
        };
      });
      const answers = await ask(`Current request:\n${request.slice(0, 4000)}`, questions);
      if (answers) {
        unjudged.forEach((o, i) => {
          const answer = answers[`relevant_${i}`];
          const value = answer?.type === "noul" ? answer.noul : answer?.value;
          if (typeof value !== "number" || !Number.isFinite(value)) return;
          remember(`${o.id}:${o.text.length}`, value);
          scores.set(o, value);
        });
      }
    }

    let dropped = 0;
    let charsSaved = 0;
    for (const [o, value] of scores) {
      if (value >= cfg.threshold) continue;
      const marker = `${MARKER} (${o.text.length} chars)]`;
      o.replace(marker);
      dropped += 1;
      charsSaved += o.text.length - marker.length;
    }
    const stats = { judged: unjudged.length, dropped, charsSaved };
    if (dropped) log?.info?.("RTK", `relevance: dropped ${dropped} tool output(s), ~${charsSaved} chars (${unjudged.length} judged)`);
    return stats;
  } catch (error) {
    log?.debug?.("RTK", `relevance skipped: ${error?.message || error}`);
    return null;
  }
}

/** Test hook. */
export function resetRelevanceCache() {
  scoreCache.clear();
}
