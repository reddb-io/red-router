import { writeFileSync } from "node:fs";
const m = await import(`${process.argv[2]}/open-sse/utils/streamTerminal.ts`);
const formats = ["openai", "claude", "openai-responses", "codex", "gemini", "antigravity", "ollama", "kiro", "cursor", "clova", "openai-response", "unknown"];
const payloads = [
  null, 5, "str", [], {},
  { done: true }, { done: false }, { done: "true" },
  { choices: [] }, { choices: [{ finish_reason: "stop" }] }, { choices: [{ finish_reason: "" }] }, { choices: [{ finish_reason: null }] },
  { choices: [{ finish_reason: 5 }] }, { choices: [{}, { finish_reason: "length" }] }, { choices: "no" },
  { type: "message_stop" }, { type: "message_delta", delta: { stop_reason: "end_turn" } }, { delta: { stop_reason: "" } }, { delta: { stop_reason: null } }, { delta: "x" },
  { type: "response.completed" }, { type: "response.incomplete" }, { type: "response.failed" }, { type: "response.cancelled" },
  { type: "response.canceled" }, { type: "response.output_text.delta" }, { type: 5 },
  { candidates: [{ finishReason: "STOP" }] }, { candidates: [{ finishReason: "" }] }, { candidates: [{}] }, { candidates: [] }, { candidates: "x" },
  { response: { candidates: [{ finishReason: "STOP" }] } }, { response: { candidates: [{}] } }, { response: "x" },
  { candidates: [{}], response: { candidates: [{ finishReason: "STOP" }] } },
];
const terminal = [];
for (const f of formats) for (const p of payloads) terminal.push([p, f, m.isStreamTerminal(p, f)]);
const requires = formats.map((f) => [f, m.requiresStreamTerminal(f)]);

const choice = (index, reason) => ({ ...(index === undefined ? {} : { index }), finish_reason: reason });
const gem = (index, reason) => ({ ...(index === undefined ? {} : { index }), finishReason: reason });
const sequences = [
  ["openai", 1, [{ choices: [choice(0, null)] }, { choices: [choice(0, "stop")] }]],
  ["openai", 1, [{ choices: [choice(undefined, null)] }, { choices: [choice(undefined, "stop")] }]],
  ["openai", 2, [{ choices: [choice(0, "stop")] }, { choices: [choice(1, null)] }, { choices: [choice(1, "stop")] }]],
  ["openai", 2, [{ choices: [choice(0, "stop"), choice(1, "stop")] }]],
  ["openai", 1, [{ choices: [choice(0, "stop"), choice(1, null)] }, { choices: [choice(1, "length")] }]],
  ["openai", 3, [{ choices: [choice(0, "stop"), choice(1, "stop")] }]],
  ["openai", 0, [{ choices: [choice(0, "stop")] }]],
  ["openai", -2, [{ choices: [choice(0, "stop")] }]],
  ["openai", 1, [{ done: true }]],
  ["openai", 1, [{ choices: [] }, { done: true }]],
  ["openai", 1, [{ choices: [choice(0.5, "stop")] }, { choices: [{ index: -0, finish_reason: "stop" }] }]],
  ["openai", 1, [{}, { choices: "x" }, { choices: [choice(0, "stop")] }]],
  ["gemini", 1, [{ candidates: [gem(0, undefined)] }, { candidates: [gem(0, "STOP")] }]],
  ["gemini", 2, [{ candidates: [gem(0, "STOP"), gem(1, undefined)] }, { candidates: [gem(1, "STOP")] }]],
  ["antigravity", 1, [{ response: { candidates: [gem(undefined, undefined)] } }, { response: { candidates: [gem(undefined, "STOP")] } }]],
  ["antigravity", 1, [{ response: { candidates: [gem(0, "STOP")] } }]],
  ["gemini", 1, [{ done: true }, {}]],
  ["claude", 1, [{ type: "message_start" }, { type: "message_stop" }]],
  ["claude", 2, [{ delta: { stop_reason: "end_turn" } }]],
  ["openai-responses", 1, [{ type: "response.output_text.delta" }, { type: "response.completed" }]],
  ["codex", 1, [{ type: "response.failed" }]],
  ["ollama", 1, [{ done: false }, { done: true }]],
  ["unknown", 1, [{ done: true }]],
];
const tracker = sequences.map(([format, expected, payloadList]) => {
  const t = m.createStreamTerminalTracker(format, expected);
  return { format, expected, steps: payloadList.map((p) => [p, t(p)]) };
});
writeFileSync(process.argv[3], JSON.stringify({ terminal, requires, tracker }));
console.log("ok", terminal.length, tracker.length);
