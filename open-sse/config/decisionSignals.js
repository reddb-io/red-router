// Deterministic request signals read before (or instead of) asking the decision
// model. Sentinels are literal strings agent harnesses put in their prompts; keep
// them here so a harness wording change is a one-line config edit.

// Blocks agent harnesses inject into user turns. They describe the harness, not
// the task, and would otherwise dominate what the decision model reads.
export const HARNESS_BLOCK_PATTERNS = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<environment_context>[\s\S]*?<\/environment_context>/g,
  /<user_instructions>[\s\S]*?<\/user_instructions>/g,
  /# AGENTS\.md instructions for[^\n]*\n+<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/g,
];

// Cheap bookkeeping calls (session titles, topic detection). Routed to the
// cheapest option without a decision call: a title request quoting the whole
// session otherwise reads as the hardest task in the pool.
export const HOUSEKEEPING_SENTINELS = [
  "You are coming up with a succinct title",
  "Write the title in the predominant language",
  "Generate a concise, sentence-case title",
  "Analyze if this message indicates a new conversation topic",
  "Please write a 5-10 word title",
];

// The agent is planning, not executing: never the weakest option for these turns.
export const PLAN_MODE_SENTINELS = [
  "Plan mode is active",
  "Plan mode still active",
  "You are currently running in \"Plan\" mode",
];

// The human explicitly asked for more deliberation.
export const EXPLICIT_THINK_PATTERN = /\b(ultrathink|think (?:really |very )?hard(?:er)?|think deeply|think carefully|pense (?:bem|com cuidado|profundamente)|raciocine com cuidado)\b/i;

// Stall: of the last STALL_WINDOW tool calls, STALL_THRESHOLD repeat the newest
// one (same name + arguments) or failed. Recomputed from the transcript each
// turn, so there is no state to expire.
export const STALL_WINDOW = 6;
export const STALL_THRESHOLD = 3;

// User agents whose system prompt is harness boilerplate rather than task context.
export const HARNESS_SYSTEM_UA = /^(claude-cli\/|claude-code\/)/i;
