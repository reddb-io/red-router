// Client-facing parameters of a model, built from the same capability tables the
// router uses to translate and route requests, so what a client is told is what the
// router will actually do. Emitted under `parameters` on /v1/models entries.

const INPUT_MODALITIES = [
  ["vision", "image"],
  ["pdf", "pdf"],
  ["audioInput", "audio"],
  ["videoInput", "video"],
];
const OUTPUT_MODALITIES = [
  ["imageOutput", "image"],
  ["audioOutput", "audio"],
];

/**
 * @param {object} caps getCapabilitiesForModel() result
 * @param {string[]|null} [thinkingLevels] levels the model accepts
 */
export function modelParameters(caps, thinkingLevels = null) {
  if (!caps || typeof caps !== "object") return null;
  const reasoning = caps.reasoning === true;
  return {
    ...(Number.isFinite(caps.contextWindow) ? { context_length: caps.contextWindow } : {}),
    ...(Number.isFinite(caps.maxOutput) ? { max_completion_tokens: caps.maxOutput } : {}),
    reasoning,
    thinking_levels: reasoning && thinkingLevels?.length ? [...thinkingLevels] : null,
    // Whether a request may turn thinking off (Fable 5.1 / Opus 5.5 400 on it).
    thinking_can_disable: !reasoning || caps.thinkingCanDisable !== false,
    // Whether a forced tool_choice (any/tool) is accepted (Fable 5.1 / Opus 5.5 400 on it).
    forced_tool_choice: caps.forcedToolChoice !== false,
    tools: caps.tools !== false,
    search: caps.search === true,
    modalities: {
      input: ["text", ...INPUT_MODALITIES.filter(([key]) => caps[key] === true).map(([, name]) => name)],
      output: ["text", ...OUTPUT_MODALITIES.filter(([key]) => caps[key] === true).map(([, name]) => name)],
    },
  };
}

/**
 * Parameters of a combo from its members'. A request may land on any member, so
 * anything a client must respect is the strictest member's: the smallest limits,
 * only the thinking levels every member accepts, and a restriction (cannot disable
 * thinking, rejects forced tool_choice) as soon as one member has it. Optional
 * features are offered when some member has them: the router moves a request that
 * needs one (an image, a search) to a member that supports it.
 * @param {object[]} list modelParameters() of each member
 */
export function mergeModelParameters(list) {
  const members = (Array.isArray(list) ? list : []).filter(Boolean);
  if (members.length === 0) return null;
  const min = (key) => {
    const values = members.map((m) => m[key]).filter(Number.isFinite);
    return values.length === members.length ? Math.min(...values) : null;
  };
  let levels = members[0].thinking_levels ? [...members[0].thinking_levels] : null;
  for (const m of members.slice(1)) {
    levels = levels && m.thinking_levels ? levels.filter((l) => m.thinking_levels.includes(l)) : null;
  }
  const union = (side) => [...new Set(members.flatMap((m) => m.modalities?.[side] || ["text"]))];
  const contextLength = min("context_length");
  const maxCompletion = min("max_completion_tokens");
  return {
    ...(contextLength !== null ? { context_length: contextLength } : {}),
    ...(maxCompletion !== null ? { max_completion_tokens: maxCompletion } : {}),
    reasoning: members.some((m) => m.reasoning),
    thinking_levels: levels?.length ? levels : null,
    thinking_can_disable: members.every((m) => m.thinking_can_disable),
    forced_tool_choice: members.every((m) => m.forced_tool_choice),
    tools: members.some((m) => m.tools),
    search: members.some((m) => m.search),
    modalities: { input: union("input"), output: union("output") },
  };
}
