/**
 * Prefix stability contract (cache economy, slice X-CACHE2).
 *
 * Providers cache by exact prefix. When turn N+1 of an agent tool-loop only APPENDS to turn N's
 * conversation, every transformation RedRouter applies before dispatch must leave the prefix
 * (system, tools, tool_choice and the messages of turn N, except the live tail) byte-identical to
 * what the same transformation produced for turn N. Otherwise the provider re-writes the whole
 * conversation into its cache on every request instead of reading it.
 *
 * Each case below runs a transformation over a synthetic multi-turn tool-loop (turn r is
 * `1 + 2r` messages, every turn appends an assistant tool call and its long tool result), keeping
 * whatever state a real session would keep, and compares consecutive turns with
 * `firstDivergence()`.
 *
 *   stable          the prefix of turn N is byte-identical in turn N+1 (asserted)
 *   known-unstable  it is not; the case asserts the instability so that the fix slice (X-CACHE3)
 *                   flips the expectation to `stable`. The divergence index is recorded in the
 *                   assertion message and in the results table printed by the last test.
 *
 * `LIVE_TAIL` messages at the end of turn N are allowed to differ: the newest message is still
 * "live" (a hint, a moving cache_control marker, ...) and is re-sent anyway.
 *
 * Analysis of every finding: docs/architecture/CACHE_PREFIX_STABILITY.md
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// The compression pipeline touches the settings DB; never let a test open the operator's.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "redrouter-cache-prefix-"));
process.env.DATA_DIR = dataDir;

const { applyCompressionAsync, selectCompressionPlan, resolveCacheAwareConfig } =
  await import("../../../open-sse/services/compression/strategySelector.ts");
const { DEFAULT_COMPRESSION_CONFIG } =
  await import("../../../open-sse/services/compression/types.ts");
const { applyLiveZoneCompression, resetLiveZoneCache } =
  await import("../../../open-sse/services/compression/liveZone.ts");
const { applyOutputStyles } =
  await import("../../../open-sse/services/compression/outputStyles/apply.ts");
const { injectHint } = await import("../../../open-sse/decision/injectHint.ts");
const { applyReasoningLevel } = await import("../../../src/sse/handlers/chat/reasoningLevel.ts");
const { compressContext, estimateTokens } =
  await import("../../../open-sse/services/contextManager.ts");
const { injectMemory } = await import("../../../src/lib/memory/injection.ts");
const { prepareClaudeRequest } =
  await import("../../../open-sse/translator/helpers/claudeHelper.ts");
const { extractSystemRoleMessages, hoistLeadingTextSystemMessages } =
  await import("../../../open-sse/handlers/chatCore/claudeSystemRole.ts");
const { cloakThirdPartyToolNames } =
  await import("../../../open-sse/services/claudeCodeToolRemapper.ts");
const { obfuscateInBody } = await import("../../../open-sse/services/claudeCodeObfuscation.ts");
const { injectCustomSystemPrompt } = await import("../../../open-sse/services/systemPrompt.ts");
const { resetDbInstance } = await import("../../../src/lib/db/core.ts");

after(() => {
  resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Messages at the end of turn N that may legitimately differ in turn N+1. */
const LIVE_TAIL = 1;
/** Turns compared: turn r has 1 + 2r messages, so 12+ turns of a tool-loop. */
const TURN_FROM = 3;
const TURN_TO = 14;

/** Top-level fields that sit in front of the messages in every provider's cache prefix. */
const PREFIX_FIELDS = ["system", "systemInstruction", "instructions", "tools", "tool_choice"];
/** Anthropic also invalidates the cached messages when the thinking parameters change. */
const THINKING_FIELDS = ["thinking", "output_config", "reasoning", "reasoning_effort"];

/** cache_control markers are breakpoints, not prefix content: compare bodies without them. */
function withoutCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCacheControl);
  if (value && typeof value === "object") {
    const out: Json = {};
    for (const [key, item] of Object.entries(value as Json)) {
      if (key === "cache_control") continue;
      out[key] = withoutCacheControl(item);
    }
    return out;
  }
  return value;
}

const bytes = (value: unknown): string => JSON.stringify(withoutCacheControl(value));

/**
 * Index of the first item of `a` (turn N) that differs in `b` (turn N+1), or -1 when `a` is a
 * prefix of `b`. A `b` shorter than `a` diverges at `b.length`.
 */
function firstDivergence(a: unknown[], b: unknown[]): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    if (bytes(a[i]) !== bytes(b[i])) return i;
  }
  return a.length > b.length ? b.length : -1;
}

interface Transition {
  turn: number; // r of turn N
  size: number; // items of turn N after the transformation
  index: number; // first divergent item, -1 when none
  prefixFields: string[]; // system / tools / tool_choice ... that changed
  stable: boolean;
}

function compareTurns(
  a: Json,
  b: Json,
  field: "messages" | "input",
  turn: number,
  fields: string[]
): Transition {
  const itemsA = Array.isArray(a[field]) ? (a[field] as unknown[]) : [];
  const itemsB = Array.isArray(b[field]) ? (b[field] as unknown[]) : [];
  const prefixFields = fields.filter((key) => bytes(a[key]) !== bytes(b[key]));
  const index = firstDivergence(itemsA, itemsB);
  const stable = prefixFields.length === 0 && (index === -1 || index >= itemsA.length - LIVE_TAIL);
  return { turn, size: itemsA.length, index, prefixFields, stable };
}

interface Verdict {
  stable: boolean;
  active: boolean; // the transformation changed the request at all
  worst: Transition | null; // deepest divergence (or the first prefix-field change)
  unstable: Transition[];
  transitions: Transition[];
}

function judge(
  raw: Json[],
  out: Json[],
  field: "messages" | "input",
  turnFrom: number,
  fields: string[]
): Verdict {
  const transitions: Transition[] = [];
  for (let i = 0; i + 1 < out.length; i++) {
    transitions.push(compareTurns(out[i], out[i + 1], field, turnFrom + i, fields));
  }
  const unstable = transitions.filter((t) => !t.stable);
  const depth = (t: Transition) => (t.prefixFields.length > 0 ? Infinity : t.size - t.index);
  const worst = unstable.length > 0 ? [...unstable].sort((x, y) => depth(y) - depth(x))[0] : null;
  const active = out.some((body, i) => bytes(body) !== bytes(raw[i]));
  return { stable: unstable.length === 0, active, worst, unstable, transitions };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Synthetic tool-loop fixtures (claude / responses / openai chat)
// ─────────────────────────────────────────────────────────────────────────────────────────────

function lcg(seed: number) {
  let s = (seed * 2654435761) >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Long tool results (6-20 KB) of the kinds agents produce: shell, grep, JSON, prose, logs. */
function bigToolResult(i: number, bigRows = false): string {
  const r = lcg(i + 1);
  switch (i % 5) {
    case 0: {
      const lines: string[] = [];
      for (let k = 0; k < 220; k++)
        lines.push(
          `\u001b[32mPASS\u001b[0m src/mod${i}/file${k % 7}.test.ts (${(r() * 100).toFixed(1)} ms)`
        );
      for (let k = 0; k < 40; k++)
        lines.push("npm warn deprecated left-pad@1.0.0: use String.prototype.padStart");
      return lines.join("\n");
    }
    case 1: {
      const lines: string[] = [];
      for (let k = 0; k < 260; k++)
        lines.push(
          `src/app/module${k}.ts:${k * 3}:  const value${k} = computeSomething(${k}, "argument ${i}");`
        );
      return lines.join("\n");
    }
    case 2: {
      const rows = [];
      for (let k = 0; k < (bigRows ? 320 : 90); k++)
        rows.push({
          id: k,
          name: `item-${i}-${k}`,
          status: k % 3 ? "ok" : "failed",
          count: Math.floor(r() * 1000),
        });
      return JSON.stringify(rows, null, 2);
    }
    case 3: {
      const paras: string[] = [];
      for (let k = 0; k < 30; k++)
        paras.push(
          `Paragraph ${k} of document ${i}. The quick brown fox jumps over the lazy dog, and then it very carefully explains that the implementation of the feature basically needs to actually be considered in order to make sure everything works properly.`
        );
      return paras.join("\n\n");
    }
    default: {
      const lines: string[] = [];
      for (let k = 0; k < 300; k++)
        lines.push(
          `2026-09-29T10:${String(k % 60).padStart(2, "0")}:00Z INFO worker-${k % 4} processed batch ${k} of job ${i} in ${(r() * 50).toFixed(2)}ms`
        );
      return lines.join("\n");
    }
  }
}

const SYSTEM_TEXT =
  "You are a careful engineering agent working inside the operator's repository. ".repeat(50);

const TOPICS = ["cache", "router", "billing", "auth", "queue", "parser", "scheduler", "exporter"];

function userRequest(group: number): string {
  const t = TOPICS[group % TOPICS.length];
  const u = TOPICS[(group + 3) % TOPICS.length];
  return (
    `Request ${group}: the ${t} module fails in CI and I need a careful diagnosis. ` +
    `Start from the ${t} tests and explain what is wrong. ` +
    `The ${u} module also touches shared fixtures, so check that too. ` +
    `Keep the change small and avoid unrelated refactors. ` +
    `Please summarise the root cause before proposing a patch. ` +
    `Do not touch the deployment configuration. ` +
    `Mention any flaky behaviour you notice along the way.`
  );
}

type SeqItem =
  | { kind: "user"; text: string }
  | { kind: "call"; id: string; name: string; args: Json; text: string }
  | { kind: "result"; id: string; output: string }
  | { kind: "reply"; text: string };

interface FixtureOptions {
  /** Client-side cache_control markers, moved to the newest message every turn like Claude Code. */
  clientCacheControl?: boolean;
  /** Assistant tool-call turns carry a signed thinking block and the body enables thinking. */
  thinking?: boolean;
  /** A `developer` reminder message is inserted before every 3rd tool result. */
  reminders?: boolean;
  /** Tool result #n mentions "delete" (content that trips the output-style auto-clarity bypass). */
  deleteInResult?: number;
  /** Tool names as third-party harnesses send them (lowercase), e.g. for the Claude OAuth cloak. */
  lowercaseTools?: boolean;
  /** The agent calls a Read tool on a few paths over and over (what read-lifecycle collapses). */
  readTool?: boolean;
  /** The caller advertises omniroute_ccr_retrieve, the only caller the ccr engine will touch. */
  ccrTool?: boolean;
  /** JSON tool results with 320 homogeneous rows (what ionizer samples). */
  bigRows?: boolean;
  /** Every tool result ends with the same footer (a shell prompt, a test summary, a banner). */
  sharedFooter?: boolean;
  /** The user's requests are long pasted specs (what ccr replaces with retrieval markers). */
  longUserText?: boolean;
}

/**
 * Item i of the (infinite) conversation. Groups of 6: a user request, two tool round-trips and a
 * closing assistant reply, so user text, assistant text and tool results all occur repeatedly.
 * Turn r is items 0..2r, so it always ends on a user-side item.
 */
function seqItem(i: number, options: FixtureOptions = {}): SeqItem {
  const group = Math.floor(i / 6);
  const pos = i % 6;
  const toolName = options.readTool ? "Read" : options.lowercaseTools ? "bash" : "Bash";
  if (pos === 0) {
    const text = userRequest(group);
    return {
      kind: "user",
      text: options.longUserText ? `${text} ${"Additional pasted context. ".repeat(40)}` : text,
    };
  }
  if (pos === 1 || pos === 3) {
    const n = Math.floor(i / 2);
    return {
      kind: "call",
      id: `toolu_${String(n).padStart(4, "0")}`,
      name: toolName,
      args: options.readTool
        ? { path: `src/file${n % 3}.ts` }
        : { command: `ls -la workspace/dir${n}` },
      text: `Step ${n}: let me inspect the workspace state with a tool.`,
    };
  }
  if (pos === 2 || pos === 4) {
    const n = Math.floor((i - 1) / 2);
    const extra =
      options.deleteInResult === n ? "\nWill delete 3 stale files from the workspace." : "";
    return {
      kind: "result",
      id: `toolu_${String(n).padStart(4, "0")}`,
      output:
        bigToolResult(n, options.bigRows === true) +
        extra +
        (options.sharedFooter
          ? "\n" +
            Array.from({ length: 8 }, (_, k) => `[footer] shared banner line ${k}`).join("\n")
          : ""),
    };
  }
  return {
    kind: "reply",
    text: `Group ${group} done: the failure came from a stale fixture, fixed.`,
  };
}

const CCR_TOOL = "omniroute_ccr_retrieve";

const BASH_SCHEMA = {
  type: "object",
  properties: { command: { type: "string" } },
  required: ["command"],
};

const TOOL_DEFS = {
  claude: (lowercase: boolean) => [
    {
      name: lowercase ? "bash" : "Bash",
      description: "Run a shell command",
      input_schema: BASH_SCHEMA,
    },
    {
      name: lowercase ? "read_file" : "Read",
      description: "Read a file",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  ],
  openai: [
    {
      type: "function",
      function: { name: "Bash", description: "Run a shell command", parameters: BASH_SCHEMA },
    },
  ],
  responses: [
    { type: "function", name: "Bash", description: "Run a shell command", parameters: BASH_SCHEMA },
  ],
};

type FixtureFormat = "claude" | "openai" | "responses";

function reminderFor(callNumber: number): Json {
  return {
    role: "developer",
    content: `Reminder ${callNumber}: the workspace policy was updated.`,
  };
}

function buildClaude(turn: number, options: FixtureOptions = {}): Json {
  const messages: Json[] = [];
  for (let i = 0; i <= 2 * turn; i++) {
    const item = seqItem(i, options);
    if (item.kind === "user")
      messages.push({ role: "user", content: [{ type: "text", text: item.text }] });
    else if (item.kind === "reply")
      messages.push({ role: "assistant", content: [{ type: "text", text: item.text }] });
    else if (item.kind === "call") {
      const blocks: Json[] = [];
      if (options.thinking)
        blocks.push({
          type: "thinking",
          thinking: `Thinking about ${item.id}: which tool gives the most signal here?`,
          signature: `sig-${item.id}-${"x".repeat(40)}`,
        });
      blocks.push({ type: "text", text: item.text });
      blocks.push({ type: "tool_use", id: item.id, name: item.name, input: item.args });
      messages.push({ role: "assistant", content: blocks });
    } else {
      const n = Number(item.id.slice(-4));
      if (options.reminders && n % 3 === 0) messages.push(reminderFor(n));
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: item.id, content: item.output }],
      });
    }
  }
  const body: Json = {
    model: "claude-opus-5-5",
    max_tokens: 8192,
    system: [{ type: "text", text: SYSTEM_TEXT }],
    tools: structuredClone(TOOL_DEFS.claude(options.lowercaseTools === true)),
    messages,
  };
  if (options.ccrTool)
    body.tools.push({ name: CCR_TOOL, description: "Retrieve", input_schema: BASH_SCHEMA });
  if (options.thinking) body.thinking = { type: "enabled", budget_tokens: 4000 };
  if (options.clientCacheControl) {
    body.system[0].cache_control = { type: "ephemeral" };
    const last = messages[messages.length - 1];
    last.content[last.content.length - 1].cache_control = { type: "ephemeral" };
  }
  return body;
}

function buildOpenAI(turn: number, options: FixtureOptions = {}): Json {
  const messages: Json[] = [{ role: "system", content: SYSTEM_TEXT }];
  for (let i = 0; i <= 2 * turn; i++) {
    const item = seqItem(i, options);
    if (item.kind === "user") messages.push({ role: "user", content: item.text });
    else if (item.kind === "reply") messages.push({ role: "assistant", content: item.text });
    else if (item.kind === "call")
      messages.push({
        role: "assistant",
        content: item.text,
        tool_calls: [
          {
            id: item.id,
            type: "function",
            function: { name: item.name, arguments: JSON.stringify(item.args) },
          },
        ],
      });
    else messages.push({ role: "tool", tool_call_id: item.id, content: item.output });
  }
  const tools = structuredClone(TOOL_DEFS.openai);
  if (options.ccrTool)
    tools.push({
      type: "function",
      function: { name: CCR_TOOL, description: "Retrieve", parameters: BASH_SCHEMA },
    });
  return { model: "gpt-5.5", tools, messages };
}

function buildResponses(turn: number, options: FixtureOptions = {}): Json {
  const input: Json[] = [];
  for (let i = 0; i <= 2 * turn; i++) {
    const item = seqItem(i, options);
    if (item.kind === "user")
      input.push({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: item.text }],
      });
    else if (item.kind === "reply")
      input.push({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: item.text }],
      });
    else if (item.kind === "call")
      input.push({
        type: "function_call",
        call_id: item.id,
        name: item.name,
        arguments: JSON.stringify(item.args),
      });
    else input.push({ type: "function_call_output", call_id: item.id, output: item.output });
  }
  const tools = structuredClone(TOOL_DEFS.responses);
  if (options.ccrTool)
    tools.push({
      type: "function",
      name: CCR_TOOL,
      description: "Retrieve",
      parameters: BASH_SCHEMA,
    });
  return { model: "gpt-5.5", instructions: SYSTEM_TEXT, tools, input };
}

function buildFixture(format: FixtureFormat, turn: number, options: FixtureOptions = {}): Json {
  if (format === "claude") return buildClaude(turn, options);
  if (format === "openai") return buildOpenAI(turn, options);
  return buildResponses(turn, options);
}

const fieldOf = (format: FixtureFormat): "messages" | "input" =>
  format === "responses" ? "input" : "messages";

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Case runner + results table
// ─────────────────────────────────────────────────────────────────────────────────────────────

type Expectation = "stable" | "known-unstable";

interface CaseDef {
  group: string;
  name: string;
  format: FixtureFormat;
  expected: Expectation;
  /** Why (for known-unstable: the root cause the fix slice must remove). */
  why?: string;
  /** Whether the transformation is expected to change the fixture at all (default true). */
  active?: boolean;
  fixture?: FixtureOptions;
  turnFrom?: number;
  /** Prefix fields compared next to the items (default: system/tools/tool_choice/instructions). */
  fields?: string[];
  /** Called once before the first turn (reset per-session state). */
  reset?: () => void;
  transform: (body: Json, turn: number) => Promise<Json> | Json;
}

interface Row {
  group: string;
  name: string;
  measured: Expectation;
  active: boolean;
  divergence: string;
  note: string;
}

const rows: Row[] = [];
/** Free-form note a transform can leave for the table (e.g. the resolved compression plan). */
let lastNote = "";

function describeWorst(v: Verdict): string {
  if (!v.worst) return "-1";
  const t = v.worst;
  const fields = t.prefixFields.length > 0 ? `${t.prefixFields.join("+")} changed` : "";
  const where = t.index < 0 ? "" : `msg ${t.index}/${t.size}`;
  return `${[fields, where].filter(Boolean).join("; ")} (turn ${t.turn})`;
}

async function runCase(def: CaseDef): Promise<Verdict> {
  def.reset?.();
  lastNote = "";
  const turnFrom = def.turnFrom ?? TURN_FROM;
  const raw: Json[] = [];
  const out: Json[] = [];
  for (let turn = turnFrom; turn <= TURN_TO; turn++) {
    const body = buildFixture(def.format, turn, def.fixture);
    raw.push(structuredClone(body));
    out.push(structuredClone(await def.transform(body, turn)));
  }
  const verdict = judge(raw, out, fieldOf(def.format), turnFrom, def.fields ?? PREFIX_FIELDS);
  rows.push({
    group: def.group,
    name: def.name,
    measured: verdict.stable ? "stable" : "known-unstable",
    active: verdict.active,
    divergence: describeWorst(verdict),
    note: lastNote,
  });

  const wantActive = def.active !== false;
  assert.equal(
    verdict.active,
    wantActive,
    `${def.name}: the transformation ${verdict.active ? "changed" : "did not change"} the fixture, ` +
      `expected ${wantActive ? "an active" : "an inert"} transformation (a vacuous pass proves nothing)`
  );
  if (def.expected === "stable") {
    assert.ok(
      verdict.stable,
      `${def.name}: expected a stable prefix, first divergence ${describeWorst(verdict)} over ` +
        `${verdict.unstable.length}/${verdict.transitions.length} transitions ` +
        `[${verdict.unstable.map((t) => `${t.index}/${t.size}`).join(", ")}]`
    );
  } else {
    assert.ok(
      !verdict.stable,
      `${def.name}: KNOWN-UNSTABLE case turned stable - flip its expectation to "stable" (${def.why ?? "see docs"})`
    );
    assert.ok(
      verdict.unstable.length > 0 && verdict.worst !== null,
      `KNOWN-UNSTABLE ${def.name}: first divergent index ${describeWorst(verdict)}, moving ` +
        `[${verdict.unstable.map((t) => `${t.index}/${t.size}`).join(", ")}] across turns. ${def.why ?? ""} ` +
        `X-CACHE3 must flip this case to "stable".`
    );
  }
  return verdict;
}

function defineCase(def: CaseDef): void {
  test(`[${def.group}] ${def.name}: ${def.expected}`, async () => {
    await runCase(def);
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// (1) Compression: the same entry points chatCore uses
//     selectCompressionPlan() (cache-aware mode) -> resolveCacheAwareConfig() -> applyCompressionAsync()
// ─────────────────────────────────────────────────────────────────────────────────────────────

const ENGINE_IDS = [
  "lite",
  "caveman",
  "aggressive",
  "ultra",
  "rtk",
  "codex-responses",
  "session-dedup",
  "ccr",
  "headroom",
  "relevance",
  "llmlingua",
  "omniglyph",
];

function engineConfig(on: Array<string | [string, string]>, extra: Json = {}): Json {
  const engines: Json = Object.fromEntries(ENGINE_IDS.map((id) => [id, { enabled: false }]));
  for (const entry of on) {
    const [id, level] = Array.isArray(entry) ? entry : [entry, undefined];
    engines[id] = level ? { enabled: true, level } : { enabled: true };
  }
  return {
    ...DEFAULT_COMPRESSION_CONFIG,
    enabled: true,
    enginesExplicit: true,
    autoTriggerTokens: 0,
    engines,
    ...extra,
  };
}

interface ProviderCtx {
  provider: string;
  targetFormat: string;
  model: string;
}

const CTX_CLAUDE: ProviderCtx = {
  provider: "claude",
  targetFormat: "claude",
  model: "claude-opus-5-5",
};
const CTX_CODEX: ProviderCtx = {
  provider: "codex",
  targetFormat: "openai-responses",
  model: "gpt-5.5",
};
const CTX_LOCAL: ProviderCtx = {
  provider: "ollama-local",
  targetFormat: "openai",
  model: "llama3",
};

type CompressResult = { body: Json; compressed: boolean; stats: unknown };
type CompressRun = (body: Json) => Promise<CompressResult>;

interface ChatCoreOptions {
  header?: string | null;
  /** Named compression combo (`x-omniroute-compression: <name>`); the header is derived from it. */
  pipeline?: Array<{ engine: string; intensity?: string; config?: Json }>;
  /** Wraps the per-request compression (the live zone does at chatCore.ts:1876). */
  wrap?: (run: CompressRun, body: Json) => Promise<CompressResult>;
}

/**
 * What handleChatCore does at ~line 1757-1925 for one request. Without an opt-in header
 * ("allow-lossy", "engine:<id>", a named combo) lossy plans are downgraded to the safe default
 * pipeline (session-dedup + lite).
 */
async function chatCoreCompression(
  body: Json,
  config: Json,
  ctx: ProviderCtx,
  options: ChatCoreOptions = {}
): Promise<Json> {
  const combos = options.pipeline ? { "combo-under-test": options.pipeline } : {};
  const header = options.pipeline ? "combo-under-test" : (options.header ?? null);
  const estimated = estimateTokens(body.messages ?? body.input ?? []);
  const plan = selectCompressionPlan(
    config as never,
    null,
    estimated,
    body,
    ctx as never,
    combos as never,
    header
  );
  const mode = plan.mode;
  lastNote =
    mode === "stacked"
      ? `stacked[${plan.stackedPipeline.map((s: { engine: string }) => s.engine).join("+")}]`
      : mode;
  if (mode === "off") return body;
  const effective =
    mode === "stacked" && plan.stackedPipeline.length > 0
      ? { ...config, stackedPipeline: plan.stackedPipeline }
      : config;
  const compressionConfig = resolveCacheAwareConfig(effective as never, body, ctx as never);
  const run: CompressRun = async (input) =>
    (await applyCompressionAsync(
      input,
      mode as never,
      {
        model: ctx.model,
        provider: ctx.provider,
        targetFormat: ctx.targetFormat as never,
        config: compressionConfig,
        cachingContext: ctx as never,
        principalId: "principal-1",
      } as never
    )) as never;
  const result = await (options.wrap ? options.wrap(run, body) : run(body));
  // chatCore keeps the client body when the pipeline reports no saving.
  return result.compressed ? result.body : body;
}

interface ModeCase {
  label: string;
  engines?: Array<string | [string, string]>;
  pipeline?: Array<{ engine: string; intensity?: string; config?: Json }>;
  header?: string | null;
  /** Context keys whose prefix is NOT stable. */
  unstable?: string[];
  /** Context keys where the engine does not touch the fixture at all. */
  inert?: string[];
  /** Fixture variant that gives the engine something to work on. */
  fixture?: FixtureOptions;
  why?: string;
}

const CONTEXTS: Array<{
  key: string;
  label: string;
  format: FixtureFormat;
  ctx: ProviderCtx;
  fixture?: FixtureOptions;
}> = [
  {
    key: "claude+cc",
    label: "claude+cache_control",
    format: "claude",
    ctx: CTX_CLAUDE,
    fixture: { clientCacheControl: true },
  },
  { key: "claude", label: "claude", format: "claude", ctx: CTX_CLAUDE },
  { key: "codex", label: "codex responses", format: "responses", ctx: CTX_CODEX },
  { key: "local", label: "openai chat/local", format: "openai", ctx: CTX_LOCAL },
];

const CLAUDE_KEYS = ["claude+cc", "claude"];
const ALL_KEYS = [...CLAUDE_KEYS, "codex", "local"];

const WHY_CURRENT_TURN =
  "lite.compressToolResults truncates every tool result older than the last assistant message " +
  "(compression/lite.ts:160-164, currentTurnStart). On Responses input the adapted messages have " +
  "no assistant message per tool call (function_call items are not messages, bodyAdapter.ts:28-34, 118), " +
  "so the 'current turn' spans the whole tool loop and all of its results are cut to 2000 chars " +
  "at once when the next assistant reply arrives.";

const WHY_DEDUP_CURRENT_TURN =
  "session-dedup never rewrites 'the current turn' = messages after the last assistant message " +
  "(engines/session-dedup/index.ts:242, 335-342). Same Responses adaptation as lite: the " +
  "current turn spans the whole tool loop, so duplicated blocks are replaced by [dedup:ref] " +
  "markers all at once when the next assistant reply arrives.";

const WHY_AGING =
  "aggressive ages messages by distance from the END of the conversation " +
  "(compression/progressiveAging.ts:105-109, thresholds in types.ts DEFAULT_AGGRESSIVE_CONFIG): a " +
  "message is raw at turn N, light at N+1, moderate/summarised later, so the first divergent " +
  "index moves back one message per turn.";

const WHY_READ_LIFECYCLE =
  "by design: a Read result is replaced by a stub as soon as the same path is read or written " +
  "again later (engines/readLifecycle/index.ts:138-145), so an old tool result that " +
  "was cached raw changes at the moment of the re-read, several messages back from the end.";

const WHY_RELEVANCE =
  "relevance scores every user message against the LAST user message (engines/relevance/index.ts:" +
  "112-118): when a new user request arrives the query changes and every earlier user message is " +
  "re-scored (and cut) against it, starting at message 0.";

const OPT_IN = "allow-lossy";

const MODE_CASES: ModeCase[] = [
  // No header: whatever the operator configured, lossy plans are downgraded to the safe pipeline.
  {
    label: "default pipeline (no header)",
    engines: ["rtk", "caveman", "aggressive"],
    unstable: ["codex"],
    inert: CLAUDE_KEYS,
    why: WHY_CURRENT_TURN,
  },
  {
    label: "opt-in mode lite",
    engines: ["lite"],
    header: OPT_IN,
    unstable: ["codex"],
    inert: CLAUDE_KEYS,
    why: WHY_CURRENT_TURN,
  },
  { label: "opt-in mode standard(caveman)", engines: ["caveman"], header: OPT_IN },
  {
    label: "opt-in mode aggressive",
    engines: ["aggressive"],
    header: OPT_IN,
    unstable: ["local"],
    why: WHY_AGING,
  },
  { label: "opt-in mode ultra", engines: ["ultra"], header: OPT_IN },
  { label: "opt-in mode rtk", engines: ["rtk"], header: OPT_IN },
  {
    label: "opt-in mode codex-responses",
    engines: ["codex-responses"],
    header: OPT_IN,
    inert: [...CLAUDE_KEYS, "local"],
  },
  { label: "opt-in stacked rtk+caveman", engines: ["rtk", "caveman"], header: OPT_IN },
  {
    label: "opt-in stacked rtk(aggressive)+caveman(ultra)",
    engines: [
      ["rtk", "aggressive"],
      ["caveman", "ultra"],
    ],
    header: OPT_IN,
  },
  // Named combos (the only way to reach engines that are not in the panel catalog), one engine each.
  { label: "combo [session-dedup]", pipeline: [{ engine: "session-dedup" }], inert: CLAUDE_KEYS },
  {
    label: "combo [session-dedup], results share a footer",
    pipeline: [{ engine: "session-dedup" }],
    fixture: { sharedFooter: true },
    unstable: ["codex"],
    inert: CLAUDE_KEYS,
    why: WHY_DEDUP_CURRENT_TURN,
  },
  {
    label: "combo [ccr], caller advertises omniroute_ccr_retrieve, long user text",
    pipeline: [{ engine: "ccr" }],
    fixture: { ccrTool: true, longUserText: true },
    inert: ["codex"],
  },
  { label: "combo [headroom]", pipeline: [{ engine: "headroom" }], inert: CLAUDE_KEYS },
  {
    label: "combo [ionizer], 320-row JSON results",
    pipeline: [{ engine: "ionizer" }],
    fixture: { bigRows: true },
    inert: CLAUDE_KEYS,
  },
  {
    label: "combo [relevance]",
    pipeline: [{ engine: "relevance" }],
    unstable: CLAUDE_KEYS,
    why: WHY_RELEVANCE,
  },
  {
    label: "combo [read-lifecycle], repeated Read of the same files",
    pipeline: [{ engine: "read-lifecycle", config: { enabled: true } }],
    fixture: { readTool: true },
    unstable: ["claude+cc", "claude", "local"],
    inert: ["codex"],
    why: WHY_READ_LIFECYCLE,
  },
  {
    label: "combo [aggressive]",
    pipeline: [{ engine: "aggressive" }],
    unstable: ALL_KEYS,
    why: WHY_AGING,
  },
  { label: "combo [ultra]", pipeline: [{ engine: "ultra" }] },
];

for (const modeCase of MODE_CASES) {
  for (const context of CONTEXTS) {
    const unstable = modeCase.unstable?.includes(context.key) === true;
    defineCase({
      group: "compression",
      name: `${modeCase.label} @ ${context.label}`,
      format: context.format,
      fixture: { ...context.fixture, ...modeCase.fixture },
      expected: unstable ? "known-unstable" : "stable",
      active: modeCase.inert?.includes(context.key) !== true,
      why: modeCase.why,
      transform: (body) =>
        chatCoreCompression(body, engineConfig(modeCase.engines ?? []), context.ctx, {
          header: modeCase.header,
          pipeline: modeCase.pipeline,
        }),
    });
  }
}

// Size-triggered plan: auto-trigger turns compression on once the conversation is big enough,
// so the whole history is rewritten at the crossing (a mode flip, not a per-message decision).
{
  const threshold = estimateTokens(buildFixture("openai", 8).messages);
  defineCase({
    group: "compression",
    name: "auto-trigger by size (off -> lite) @ openai chat/local",
    format: "openai",
    expected: "known-unstable",
    why:
      "selectCompressionPlan() picks autoTriggerMode from the ESTIMATED SIZE of the whole request " +
      "(strategySelector.ts:160): below autoTriggerTokens nothing is compressed, above it lite " +
      "truncates every old tool result, so the crossing rewrites the entire history once.",
    transform: (body) =>
      chatCoreCompression(
        body,
        engineConfig([], { autoTriggerTokens: threshold, autoTriggerMode: "lite" }),
        CTX_LOCAL
      ),
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// (2) Live zone (default OFF): reuse of the transformed prefix per session
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Position-dependent stand-in engine: keeps the last 6 messages raw, cuts older tool results. */
async function positionalAging(body: Json): Promise<CompressResult> {
  const items = body.messages as Json[];
  const next = items.map((item, index) => {
    if (index >= items.length - 6) return item;
    if (!Array.isArray(item.content)) return item;
    return {
      ...item,
      content: item.content.map((block: Json) =>
        block.type === "tool_result" && typeof block.content === "string"
          ? { ...block, content: `${block.content.slice(0, 200)}\n...[aged]` }
          : block
      ),
    };
  });
  return { body: { ...body, messages: next }, compressed: true, stats: null };
}

let liveZoneHits = 0;
let liveZoneCalls = 0;

const liveZoneWrap =
  (sessionId: string | undefined) =>
  async (run: CompressRun, body: Json): Promise<CompressResult> => {
    const result = await applyLiveZoneCompression(
      body,
      { principalId: "principal-1", sessionId, variant: { mode: "live-zone-test" }, ttlMinutes: 5 },
      run as never
    );
    liveZoneCalls++;
    if ((result.stats as Json | null)?.liveZone?.cacheHit === true) liveZoneHits++;
    lastNote =
      `${lastNote.replace(/ ?live-zone hits .*$/, "")} live-zone hits ${liveZoneHits}/${liveZoneCalls}`.trim();
    return result as never;
  };

const resetLiveZone = () => {
  resetLiveZoneCache();
  liveZoneHits = 0;
  liveZoneCalls = 0;
};

defineCase({
  group: "live-zone",
  name: "OFF: positional aging @ claude (control)",
  format: "claude",
  expected: "known-unstable",
  why: "any per-position rule rewrites messages that were already sent (see compression cases)",
  transform: async (body) => (await positionalAging(body)).body,
});
defineCase({
  group: "live-zone",
  name: "ON, stable session: combo [aggressive] @ openai chat/local",
  format: "openai",
  expected: "stable",
  reset: resetLiveZone,
  transform: (body) =>
    chatCoreCompression(body, engineConfig([]), CTX_LOCAL, {
      pipeline: [{ engine: "aggressive" }],
      wrap: liveZoneWrap("session-1"),
    }),
});
defineCase({
  group: "live-zone",
  name: "ON, stable session: default pipeline @ codex responses",
  format: "responses",
  expected: "stable",
  reset: resetLiveZone,
  transform: (body) =>
    chatCoreCompression(body, engineConfig(["rtk", "caveman", "aggressive"]), CTX_CODEX, {
      wrap: liveZoneWrap("session-1"),
    }),
});
defineCase({
  group: "live-zone",
  name: "ON, stable session: positional aging @ claude, no client markers",
  format: "claude",
  expected: "stable",
  // The frozen turn-3 prefix is reused for the whole session, so the aging rule never fires.
  active: false,
  reset: resetLiveZone,
  transform: async (body) => (await liveZoneWrap("session-1")(positionalAging, body)).body,
});
defineCase({
  group: "live-zone",
  name: "ON, stable session: positional aging @ claude+cache_control (marker moves)",
  format: "claude",
  fixture: { clientCacheControl: true },
  expected: "known-unstable",
  why:
    "the live zone reuses the frozen prefix only when the RAW prefix digest matches " +
    "(liveZone.ts:188-194, 391) and digests include cache_control: a client that moves its " +
    "breakpoint to the newest message every turn (Claude Code) makes the digest differ on every " +
    "request, so it never hits and falls back to full compression.",
  reset: resetLiveZone,
  transform: async (body) => (await liveZoneWrap("session-1")(positionalAging, body)).body,
});
defineCase({
  group: "live-zone",
  name: "ON, no session id: positional aging @ claude",
  format: "claude",
  expected: "known-unstable",
  why: "without a session id the live zone cannot key its cache (liveZone.ts:127-133) and compresses the full history",
  reset: resetLiveZone,
  transform: async (body) => (await liveZoneWrap(undefined)(positionalAging, body)).body,
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// (3) Trailing hint injection
// ─────────────────────────────────────────────────────────────────────────────────────────────

const HINT_WHY =
  "injectHint() writes into the last `user` message, except in the middle of a tool loop " +
  "(a tool / function_call_output tail), where it adds its own trailing message so the request " +
  "that started the loop is never rewritten (decision/injectHint.ts, applied at " +
  "chatCore/toolDecision.ts:151).";

for (const [format, fixture] of [
  ["claude", { clientCacheControl: true }],
  ["openai", undefined],
  ["responses", undefined],
] as const) {
  for (const variant of ["same tool every turn", "suggested tool changes per turn"]) {
    defineCase({
      group: "hint",
      name: `injectHint, ${variant} @ ${format}${fixture ? "+cache_control" : ""}`,
      format,
      fixture,
      expected: "stable",
      why: HINT_WHY,
      transform: (body, turn) => {
        const tool =
          variant === "same tool every turn" ? "Bash" : ["Bash", "Read", "Grep"][turn % 3];
        assert.equal(
          injectHint(body, format === "responses" ? "openai-responses" : format, tool),
          true
        );
        return body;
      },
    });
  }
}

test("[hint] the hint lands after the client's cache_control breakpoint", () => {
  const body = buildFixture("claude", 6, { clientCacheControl: true });
  const before = structuredClone(body.messages[body.messages.length - 1].content);
  assert.equal(injectHint(body, "claude", "Bash"), true);
  const content = body.messages[body.messages.length - 1].content;
  assert.equal(content.length, before.length + 1);
  assert.deepEqual(
    content.slice(0, before.length),
    before,
    "original blocks (and marker) untouched"
  );
  assert.equal(content[before.length].cache_control, undefined, "the hint block carries no marker");
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// (4) Reasoning level
// ─────────────────────────────────────────────────────────────────────────────────────────────

const levelFor = (turn: number): string => (turn % 2 === 0 ? "high" : "low");

for (const format of ["claude", "openai", "responses"] as const) {
  defineCase({
    group: "reasoning",
    name: `applyReasoningLevel flips effort each turn: messages/system/tools @ ${format}`,
    format,
    expected: "stable",
    transform: (body, turn) => applyReasoningLevel(body, levelFor(turn), format),
  });
  defineCase({
    group: "reasoning",
    name: `applyReasoningLevel flips effort each turn: thinking params @ ${format}`,
    format,
    expected: "known-unstable",
    why:
      "KNOWN CAUSE (not a rewrite bug): Anthropic invalidates the cached MESSAGES whenever the " +
      "thinking parameters change (system and tools stay cached). The router sets the effort per " +
      "request (src/sse/handlers/chat/reasoningLevel.ts), so a level that changes between turns " +
      "of the same conversation costs a full message re-write. Pin the level per conversation.",
    fields: [...PREFIX_FIELDS, ...THINKING_FIELDS],
    transform: (body, turn) => applyReasoningLevel(body, levelFor(turn), format),
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// (5) Other body rewriting in the chat pipeline
// ─────────────────────────────────────────────────────────────────────────────────────────────

// 5a. Reactive context compaction (open-sse/services/contextManager.ts, chatCore.ts:2127-2189).
{
  const rawTokens = (turn: number) => estimateTokens(buildFixture("claude", turn).messages);
  // Small enough that every turn from COMPACTION_FROM is over it, big enough that layer 1 (trim
  // every tool result to 2000 chars) always fits. chatCore triggers at ~70% of the model window.
  const COMPACTION_FROM = 9;
  const layer1Only = estimateTokens(
    buildFixture("claude", TURN_TO).messages.map((m: Json) =>
      m.role === "user" && Array.isArray(m.content)
        ? {
            ...m,
            content: m.content.map((b: Json) =>
              b.type === "tool_result" && typeof b.content === "string" && b.content.length > 2000
                ? { ...b, content: `${b.content.slice(0, 2000)}\n... [truncated]` }
                : b
            ),
          }
        : m
    )
  );
  const fitsAfterTrim = layer1Only;
  assert.ok(
    rawTokens(COMPACTION_FROM) > fitsAfterTrim,
    "fixture sizing: raw must exceed the target"
  );

  defineCase({
    group: "compaction",
    name: "compressContext below the threshold (identity) @ claude",
    format: "claude",
    expected: "stable",
    active: false,
    transform: (body) =>
      compressContext(body, { maxTokens: 10_000_000, reserveTokens: 0 }).body as Json,
  });
  defineCase({
    group: "compaction",
    name: "compressContext steady above threshold, layer 1 only (trim tool results) @ claude",
    format: "claude",
    turnFrom: COMPACTION_FROM,
    expected: "stable",
    transform: (body) =>
      compressContext(body, { maxTokens: fitsAfterTrim, reserveTokens: 0 }).body as Json,
  });
  defineCase({
    group: "compaction",
    name: "compressContext crossing the threshold (raw -> trimmed) @ claude",
    format: "claude",
    expected: "known-unstable",
    why:
      "chatCore compacts only when the estimate passes ~70% of the context window " +
      "(chatCore.ts:2125-2151): the request before the crossing is raw, the next one has EVERY tool " +
      "result cut to 2000 chars (contextManager.ts trimToolMessages), so the whole history is " +
      "re-written once - at the moment the conversation is largest and most expensive.",
    transform: (body) =>
      compressContext(body, { maxTokens: rawTokens(8) + 5, reserveTokens: 0 }).body as Json,
  });
  defineCase({
    group: "compaction",
    name: "compressContext purifyHistory sliding window @ claude",
    format: "claude",
    turnFrom: COMPACTION_FROM,
    expected: "known-unstable",
    why:
      "when trimming is not enough purifyHistory keeps only the newest `keep` messages, shrinking " +
      "keep by 30% steps until it fits (contextManager.ts purifyHistory); the first kept index " +
      "moves with the total size on every turn, so every request has a different start and the " +
      "provider cache is missed from message 0.",
    transform: (body) =>
      compressContext(body, {
        maxTokens: Math.max(Math.floor(fitsAfterTrim / 3), 1),
        reserveTokens: 0,
      }).body as Json,
  });
}

// 5b. Memory injection (off by default; open-sse/handlers/chatCore/memorySkillsInjection.ts).
const MEMORY_A = [{ content: "The operator prefers small diffs." }];
const memoryFor = (turn: number) => {
  const group = Math.floor((2 * turn) / 6);
  return [
    { content: `Memory for request ${group}: prefer the ${TOPICS[group % TOPICS.length]} module.` },
  ];
};
defineCase({
  group: "memory",
  name: "injectMemory cache-safe splice (before the last user message) @ openai chat",
  format: "openai",
  expected: "known-unstable",
  why:
    "with cache_control present the memory message is spliced immediately BEFORE the last user " +
    "message (src/lib/memory/injection.ts:264, placeMessage at 228); the anchor is the last user " +
    "turn, so the splice point moves every time a new user request arrives and the previous one " +
    "loses its memory message (everything after it shifts).",
  transform: (body) =>
    injectMemory(body as never, MEMORY_A as never, "openai", { cacheSafe: true }) as Json,
});
defineCase({
  group: "memory",
  name: "injectMemory system-first, same memories every turn @ claude",
  format: "claude",
  expected: "stable",
  transform: (body) =>
    injectMemory(body as never, MEMORY_A as never, "claude", { cacheSafe: false }) as Json,
});
defineCase({
  group: "memory",
  name: "injectMemory system-first, memories retrieved per user request @ claude",
  format: "claude",
  expected: "known-unstable",
  why:
    "retrieval is keyed on the last user query, so a new user request changes the memory text that " +
    "is merged into the top-level system field (injection.ts injectSystemFirst): the system " +
    "prefix - and with it the whole cache - changes at every new user request.",
  transform: (body, turn) =>
    injectMemory(body as never, memoryFor(turn) as never, "claude", { cacheSafe: false }) as Json,
});

// 5c. Anthropic body preparation for OpenAI-format clients (translator/helpers/claudeHelper.ts).
defineCase({
  group: "claude-prep",
  name: "prepareClaudeRequest (provider claude, synthesized markers), no thinking",
  format: "claude",
  expected: "stable",
  active: false,
  transform: (body) =>
    prepareClaudeRequest(body as never, "claude", false, "claude-opus-5-5") as Json,
});
defineCase({
  group: "claude-prep",
  name: "prepareClaudeRequest (provider claude), signed thinking in history",
  format: "claude",
  fixture: { thinking: true },
  expected: "known-unstable",
  why:
    "the LATEST assistant message keeps its signed thinking block verbatim but every older one is " +
    "rewritten to redacted_thinking with a synthetic blob (claudeHelper.ts:539-543, 587-600, the " +
    "isLatestAssistant branch): the assistant turn that was 'latest' at turn N is rewritten at " +
    "N+1, so its bytes change one turn after they were cached (depth 2 from the end).",
  transform: (body) =>
    prepareClaudeRequest(body as never, "claude", false, "claude-opus-5-5") as Json,
});
defineCase({
  group: "claude-prep",
  name: "prepareClaudeRequest (client markers preserved), signed thinking in history",
  format: "claude",
  fixture: { thinking: true, clientCacheControl: true },
  expected: "known-unstable",
  why: "same thinking rewrite; preserveCacheControl only protects the markers, not the thinking blocks",
  transform: (body) =>
    prepareClaudeRequest(body as never, "claude", true, "claude-opus-5-5") as Json,
});

// 5d. System hoisting (chatCore/claudeSystemRole.ts, claudeUpstreamMessages.ts).
defineCase({
  group: "system-hoist",
  name: "extractSystemRoleMessages: mid-conversation developer reminders @ claude",
  format: "claude",
  fixture: { reminders: true },
  expected: "known-unstable",
  why:
    "every system/developer message anywhere in the conversation is lifted into the top-level " +
    "`system` (claudeSystemRole.ts:104-160), so a reminder that a client appends mid-conversation " +
    "changes `system` - the very front of the cache prefix - and invalidates everything. The " +
    "mid-conversation-system path keeps them in place (next case).",
  transform: (body) => {
    extractSystemRoleMessages(body);
    return body;
  },
});
defineCase({
  group: "system-hoist",
  name: "hoistLeadingTextSystemMessages (mid-conversation system kept in place) @ claude",
  format: "claude",
  fixture: { reminders: true },
  expected: "stable",
  active: false,
  transform: (body) => {
    hoistLeadingTextSystemMessages(body);
    return body;
  },
});

// 5e. Output styles (system-prompt injection; compression/outputStyles/apply.ts).
const STYLE_SELECTION = [{ id: "terse-prose", level: "full" as const }];
defineCase({
  group: "output-style",
  name: "applyOutputStyles, benign content @ openai chat",
  format: "openai",
  expected: "stable",
  transform: (body) => applyOutputStyles(body as never, STYLE_SELECTION, "en").body as Json,
});
defineCase({
  group: "output-style",
  name: "applyOutputStyles, a tool result mentions 'delete' @ openai chat",
  format: "openai",
  fixture: { deleteInResult: 6 },
  expected: "known-unstable",
  why:
    "the auto-clarity bypass scans the text of the LAST 3 messages (outputMode.ts:96-126, " +
    "shouldBypassCavemanOutputMode, called at outputStyles/apply.ts:207): while a tool result containing 'delete'/'security'/'step by " +
    "step' is within the last 3 messages the style instruction is dropped from the system prompt " +
    "and it comes back afterwards, so the system prefix flips twice per occurrence.",
  transform: (body) => applyOutputStyles(body as never, STYLE_SELECTION, "en").body as Json,
});

// 5f. Operator-configured custom system prompt (chatCore.ts:650-664).
for (const format of ["claude", "openai"] as const) {
  defineCase({
    group: "system-prompt",
    name: `injectCustomSystemPrompt @ ${format}`,
    format,
    expected: "stable",
    transform: (body) =>
      injectCustomSystemPrompt(body, "Always answer in the operator's house style."),
  });
}

// 5g. Claude OAuth cloak (executors/base.ts:984-1010).
defineCase({
  group: "cloak",
  name: "cloakThirdPartyToolNames + obfuscateInBody @ claude (lowercase tools)",
  format: "claude",
  fixture: { lowercaseTools: true },
  expected: "stable",
  transform: (body) => {
    cloakThirdPartyToolNames(body);
    obfuscateInBody(body);
    return body;
  },
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Guards + the deliverable table
// ─────────────────────────────────────────────────────────────────────────────────────────────

test("[compression] getCacheAwareStrategy().deterministicOnly has no consumer", () => {
  // The cache-aware strategy advertises `deterministicOnly: true` for caching providers, but no
  // compression module reads it: a caching provider is NOT restricted to deterministic engines
  // (see the combo [aggressive] cases above). When a consumer appears, update this guard and the
  // doc.
  const consumers: string[] = [];
  for (const root of ["open-sse", "src"]) {
    for (const entry of fs.readdirSync(path.join(process.cwd(), root), { recursive: true })) {
      const file = String(entry);
      if (!/\.(ts|tsx)$/.test(file)) continue;
      const text = fs.readFileSync(path.join(process.cwd(), root, file), "utf8");
      if (text.includes("deterministicOnly")) consumers.push(`${root}/${file}`);
    }
  }
  assert.deepEqual(consumers, ["open-sse/services/compression/cachingAware.ts"]);
});

test("results table (deliverable)", () => {
  const width = Math.max(...rows.map((r) => r.name.length));
  const lines = rows.map(
    (r) =>
      `${r.group.padEnd(13)} ${r.name.padEnd(width)}  ${r.measured.padEnd(14)} ` +
      `${r.active ? "active" : "inert "}  ${r.divergence}${r.note ? `  [${r.note}]` : ""}`
  );
  const unstable = rows.filter((r) => r.measured === "known-unstable").length;
  console.log(
    `\nPREFIX STABILITY CONTRACT (LIVE_TAIL=${LIVE_TAIL}, turns ${TURN_FROM}..${TURN_TO}; ` +
      `${rows.length} cases, ${unstable} known-unstable)\n` +
      `divergence = worst transition: first differing item / items of turn N\n${lines.join("\n")}\n`
  );
  assert.ok(rows.length > 0);
});
