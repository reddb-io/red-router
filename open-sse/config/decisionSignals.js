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
  // redcode (packages/redcode/src/agent/prompt/title.txt)
  "You are a title generator. You output ONLY a thread title.",
  "Generate a brief title that would help the user find this conversation later",
];

// The agent is planning, not executing: never the weakest option for these turns.
export const PLAN_MODE_SENTINELS = [
  "Plan mode is active",
  "Plan mode still active",
  "You are currently running in \"Plan\" mode",
];

// The human explicitly asked for more deliberation.
export const EXPLICIT_THINK_PATTERN = /\b(ultrathink|think (?:really |very )?hard(?:er)?|think deeply|think carefully|pense (?:bem|com cuidado|profundamente)|raciocine com cuidado)\b/i;

// Wrap alternatives in Unicode-aware word boundaries: `\b` treats accented letters
// ("não", "ótimo") as non-word characters and would miss or split them.
const phrases = (list, flags = "iu") => new RegExp(`(?<![\\p{L}\\p{N}_])(?:${list.join("|")})(?![\\p{L}\\p{N}_])`, flags);

// How the human judged the previous answer, read from their newest message. Kept
// conservative: a miss costs nothing, a false "rejects" raises the level for a turn.
// Corrections and rejections are checked first, so "perfeito, mas ainda quebrado"
// reads as a correction.
export const FEEDBACK_REJECTS_PATTERN = phrases([
  "n[ãa]o (?:era|é|foi) (?:isso|isto|o que (?:eu )?(?:pedi|queria))",
  "n[ãa]o (?:foi|é) isso que (?:eu )?(?:pedi|queria)",
  "de novo n[ãa]o",
  "t[áa] errado",
  "isso (?:est[áa]|t[áa]) errado",
  "not what i (?:asked|wanted|meant)",
  "that'?s (?:not it|wrong)",
  "this is wrong",
  "(?:you )?got it wrong",
  "undo (?:that|this)",
  "desfa[çz]a (?:isso|isto)",
]);
export const FEEDBACK_CORRECTS_PATTERN = phrases([
  "n[ãa]o,? eu quis dizer",
  "eu quis dizer",
  "na verdade,? eu",
  "como eu (?:disse|falei)",
  "(?:eu )?j[áa] (?:disse|falei)",
  "ainda (?:est[áa] |t[áa] )?(?:quebrad[oa]|falhando|com erro|dando erro)",
  "ainda n[ãa]o (?:funciona|funcionou|passou|compila)",
  "continua (?:quebrad[oa]|falhando|dando erro)",
  "no,? i meant",
  "what i meant (?:was|is)",
  "like i said",
  "as i said",
  "i already (?:said|told you)",
  "still (?:broken|failing|not working|doesn'?t work|fails|wrong)",
]);
// Agreement only counts at the start of the message: "great, now also…" agrees,
// "this is great but broken" does not.
export const FEEDBACK_AGREES_PATTERN = /^\s*(?:perfeito|isso mesmo|isso a[íi]|exatamente|[óo]timo|excelente|ok,? (?:segue|continua|pode seguir|manda ver)|pode seguir|perfect|exactly|great|lgtm|looks good|nice|ship it|ok,? (?:go on|continue|proceed)|go ahead)(?![\p{L}\p{N}_])/iu;

// Frustration markers and the weight each adds (summed, capped at 1). No single
// marker reaches the step-up threshold (0.6) on its own: it takes two.
export const FRUSTRATION_MARKERS = [
  { weight: 0.4, pattern: phrases(["porra", "caralho", "merda", "puta que pariu", "pqp", "vsf", "wtf", "fuck(?:ing)?", "shit", "ffs", "damn(?: it)?", "crap"]) },
  { weight: 0.3, pattern: phrases(["de novo", "outra vez", "pela (?:en[ée]sima|terceira|quarta|quinta) vez", "quantas vezes", "j[áa] (?:disse|falei)", "again", "how many times", "for the (?:third|fourth|fifth|nth|last) time", "i (?:already )?told you"]) },
  { weight: 0.2, pattern: /[!?]{3,}|\?!|!\?/ },
];
// A message mostly in capitals reads as shouting. Needs enough letters to judge.
export const FRUSTRATION_SHOUT = { weight: 0.4, minLetters: 12, ratio: 0.7 };
export const FRUSTRATION_STEP_UP = 0.6;

// Stall: of the last STALL_WINDOW tool calls, STALL_THRESHOLD repeat the newest
// one (same name + arguments) or failed. Recomputed from the transcript each
// turn, so there is no state to expire.
export const STALL_WINDOW = 6;
export const STALL_THRESHOLD = 3;

// User agents whose system prompt is harness boilerplate rather than task context.
export const HARNESS_SYSTEM_UA = /^(claude-cli\/|claude-code\/)/i;
