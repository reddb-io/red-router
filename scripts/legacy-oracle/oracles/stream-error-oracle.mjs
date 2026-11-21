import { writeFileSync } from "node:fs";
Date.now = () => 1_700_000_000_000;
const m = await import(`${process.argv[2]}/open-sse/utils/streamErrorFormat.ts`);
const clean = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

const payloads = [
  null, 5, "str", [], {},
  { error: { message: "boom", code: "rate_limit_exceeded", type: "x" } },
  { error: { message: "bad", type: "invalid_request_error" } },
  { error: { message: "ctx", code: "context_length_exceeded" } },
  { error: { message: "auth", type: "authentication_error" } },
  { error: { message: "key", code: "invalid_api_key" } },
  { error: { message: "perm", type: "permission_error" } },
  { error: { message: "perm2", code: "permission_denied" } },
  { error: { message: "pay", type: "billing_error" } },
  { error: { message: "pay2", code: "payment_required" } },
  { error: { message: "You exceeded your current quota" } },
  { error: { message: "Too Many Requests" } },
  { error: { message: "usage_limit_reached" } },
  { error: { message: "limit has been reached for plan" } },
  { error: { message: "plain" } },
  { error: { message: "n", code: 429 } },
  { error: { message: "n", code: "503" } },
  { error: { message: "n", code: 200 } },
  { error: { message: "n", status: 418 } },
  { error: { message: "n", status_code: "401" } },
  { error: "just a string" },
  { error: "   " },
  { error: {}, message: "root message" },
  { message: "only root message", status: 504 },
  { status: 99, message: "bad status" },
  { type: "error", error: { type: "overloaded_error", message: "busy" } },
  { type: "response.failed", response: { error: { code: "server_error", message: "resp err" }, status: "failed" } },
  { type: "response.failed", response: { last_error: { code: "rate_limit_exceeded", message: "last" } } },
  { type: "response.failed", response: { error: "string resp error" } },
  { type: "response.failed", response: { last_error: "string last error" } },
  { type: "response.failed" },
  { type: "response.completed", response: { status: "failed", error: { message: "completed but failed" } } },
  { type: "response.completed", response: { status: "completed" } },
  {
    type: "response.failed", sequence_number: 7,
    response: {
      id: "resp_123", object: "response", created_at: 1700000000, model: "gpt-5", status: "failed", background: false,
      error: { code: "server_error", message: "boom" }, last_error: { message: "x" },
      usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7, input_tokens_details: { cached_tokens: 1, other: 2 }, output_tokens_details: { reasoning_tokens: 2, hack: 9 }, extra: 5 },
      diagnostics: { stack: "secret" }, temperature: 0.5, store: false, truncation: "disabled", max_tool_calls: null,
      output: [
        { type: "message", role: "assistant", id: "msg_1", status: "completed", content: [{ type: "output_text", text: "partial", annotations: [{ x: 1 }] }, { type: "refusal", refusal: "no" }, { type: "output_text", text: "c", phase: "commentary" }, { type: "output_text", text: 5 }, { type: "other" }] },
        { type: "message", role: "assistant", phase: "commentary", content: [] },
        { type: "message", role: "user", content: [] },
        { type: "reasoning", summary: [] },
        { type: "message", role: "assistant", id: "bad id with spaces", status: "weird" },
      ],
    },
  },
  { type: "response.failed", response: { id: "id with space", model: "bad model!", previous_response_id: "ok_1", error: { message: "m" } } },
  { type: "response.failed", response: { id: "/Users/someone/x", error: { message: "m" }, object: "see /home/user/file" } },
  { type: "response.failed", response: { object: "Bearer sk-abcdefghijklmnop", error: { message: "m" } } },
  { type: "response.failed", response: { output: "not array", usage: "nope", error: { message: "m" } } },
  { error: { message: "token sk-secretsecretsecretsecret leaked at /Users/me/app/x.js" } },
];
const normalize = payloads.map((p) => [p, clean(m.normalizeStreamFailurePayload(p))]);
const project = payloads.map((p) => [p, clean(m.projectStreamFailureEvent(p))]);
const prepare = payloads.map((p) => [p, clean(m.prepareTranslatedStreamFailure(p))]);
const formats = [undefined, "openai", "claude", "openai-responses", "gemini"];
const format = [];
for (const p of payloads) for (const f of formats) format.push([p, f ?? null, m.formatTranslatedStreamError(p, f)]);
const completed = [
  [502, "oops", "server_error"], [429, "slow", undefined], [400, "bad", "invalid_request_error"], [500, "x".repeat(10), null],
].map(([status, message, type]) => [status, message, type ?? null, clean(m.projectCompletedStreamError({ status, message, ...(type ? { type } : {}) }))]);
writeFileSync(process.argv[3], JSON.stringify({ normalize, project, prepare, format, completed }));
console.log("ok", normalize.length, project.length, prepare.length, format.length, completed.length);
