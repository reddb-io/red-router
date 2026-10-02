import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

const directory = mkdtempSync(join(tmpdir(), "redrouter-idempotency-isolation-"));
process.env.DATA_DIR = directory;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const { resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { clearIdempotency, saveIdempotency } = await import("../../../src/lib/idempotencyLayer.ts");
const { checkIdempotencyCache, composeIdempotencyKey } =
  await import("../../../open-sse/handlers/chatCore/idempotency.ts");

const rawKey = "retry-client-id";
const scope = { apiKeyId: "tenant-a-key", provider: "openrouter", model: "reasoner" };
const original: Record<string, unknown> = {
  messages: [{ role: "user", content: "Explain this algorithm." }],
  temperature: 0,
  reasoning_effort: "low",
};
const panelResponse = { choices: [{ message: { content: "Panel answer" } }] };

beforeEach(() => clearIdempotency());
after(() => {
  clearIdempotency();
  resetDbInstance();
  rmSync(directory, { recursive: true, force: true });
});

function compose(body = original, overrides: Partial<typeof scope> & { rawKey?: string } = {}) {
  return composeIdempotencyKey({
    rawKey,
    ...scope,
    messages: body.messages,
    body,
    ...overrides,
  });
}

function lookup(
  body = original,
  overrides: {
    apiKeyId?: string | null;
    provider?: string;
    model?: string;
    clientRawRequest?: { headers: Headers };
    log?: { debug: (...args: unknown[]) => void };
  } = {}
) {
  return checkIdempotencyCache({
    clientRawRequest: { headers: new Headers({ "idempotency-key": rawKey }) },
    ...scope,
    body,
    effectiveServiceTier: undefined,
    startTime: Date.now(),
    log: undefined,
    ...overrides,
  });
}

test("long-window retries replay only for the same API key identity", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const first = await lookup();
  assert.equal(first.hit, null);
  assert.ok(first.idempotencyKey);
  saveIdempotency(first.idempotencyKey, panelResponse, 200, 12_000);
  t.mock.timers.tick(5001);

  const logs: unknown[][] = [];
  const retried = await lookup(original, { log: { debug: (...args) => logs.push(args) } });
  assert.ok(retried.hit);
  assert.equal(retried.idempotencyKey, first.idempotencyKey);
  assert.deepEqual(await retried.hit.response.json(), panelResponse);
  assert.equal(retried.hit.response.headers.get("X-OmniRoute-Idempotent"), "true");

  for (const apiKeyId of ["tenant-b-key", null, undefined]) {
    const other = await lookup(original, { apiKeyId });
    assert.equal(other.hit, null);
    assert.notEqual(other.idempotencyKey, first.idempotencyKey);
  }
  const logged = JSON.stringify(logs);
  assert.ok(logs.length > 0);
  assert.ok(!logged.includes(rawKey));
  assert.ok(!logged.includes(scope.apiKeyId));
});

test("effort and provider generation containers cannot replay a different contract", async () => {
  const first = await lookup();
  saveIdempotency(first.idempotencyKey, panelResponse, 200, 12_000);
  for (const changed of [
    { reasoning_effort: "high" },
    { reasoning: { effort: "high" } },
    { thinking: { type: "enabled", budget_tokens: 8000 } },
    { output_config: { effort: "high" } },
    { options: { num_predict: 800 } },
    { generationConfig: { thinkingConfig: { thinkingBudget: 8000 } } },
    { generation_config: { max_output_tokens: 800 } },
    { chat_template_kwargs: { enable_thinking: false } },
    { extra_body: { thinking: { type: "disabled" } } },
    { provider_options: { inference: { reasoning: false } } },
    { response_schema: { type: "object", properties: { answer: { type: "string" } } } },
    { response_mime_type: "application/json" },
    { response_format: { type: "json_object" } },
    { text: { format: { type: "json_object" }, verbosity: "high" } },
    { functions: [{ name: "lookup", parameters: { type: "object" } }] },
    { function_call: "none" },
    { tools: [{ type: "function", function: { name: "lookup", strict: true } }] },
    { tool_choice: "none" },
    { parallel_tool_calls: false },
    { temperature: 1 },
    { top_p: 0.9 },
    { top_k: 10 },
    { seed: 42 },
    { stop: ["END"] },
    { stop_sequences: ["END"] },
    { repetition_penalty: 1.2 },
    { max_tokens: 800 },
    { max_completion_tokens: 800 },
    { max_output_tokens: 800 },
  ]) {
    const result = await lookup({ ...original, ...changed });
    assert.equal(result.hit, null, JSON.stringify(changed));
    assert.notEqual(result.idempotencyKey, first.idempotencyKey, JSON.stringify(changed));
  }
  assert.ok((await lookup()).hit);
});

test("fusion panels and the judge keep separate responses while judge retries replay", async () => {
  const panel = await lookup();
  saveIdempotency(panel.idempotencyKey, panelResponse, 200, 12_000);
  const otherPanel = await lookup(original, { model: "another-panel-model" });
  assert.equal(otherPanel.hit, null);
  assert.notEqual(otherPanel.idempotencyKey, panel.idempotencyKey);
  const judgeBody = {
    ...original,
    messages: [
      ...(original.messages as Array<Record<string, unknown>>),
      { role: "user", content: "You are the judge. Synthesize the panel answers." },
    ],
  };
  const judge = await lookup(judgeBody);
  assert.equal(judge.hit, null);
  assert.notEqual(judge.idempotencyKey, panel.idempotencyKey);
  const judgeResponse = { choices: [{ message: { content: "Judge synthesis" } }] };
  saveIdempotency(judge.idempotencyKey, judgeResponse, 200, 12_000);
  const retry = await lookup(judgeBody);
  assert.ok(retry.hit);
  assert.deepEqual(await retry.hit.response.json(), judgeResponse);
  const panelRetry = await lookup();
  assert.ok(panelRetry.hit);
  assert.deepEqual(await panelRetry.hit.response.json(), panelResponse);
});

test("key namespaces are unambiguous and API key identity stays outside the digest", () => {
  const a = compose(original, { apiKeyId: "tenant|one", rawKey: "retry" });
  const b = compose(original, { apiKeyId: "tenant", rawKey: "one|retry" });
  assert.ok(a && b);
  assert.notEqual(a, b);
  const components = JSON.parse(a) as string[];
  assert.equal(components[1], "tenant|one");
  assert.equal(components.at(-1), (JSON.parse(b) as string[]).at(-1));
  assert.match(components.at(-1)!, /^[a-f0-9]{64}$/);
  assert.notEqual(
    compose(original, { rawKey: "retry|provider", provider: "one" }),
    compose(original, { rawKey: "retry", provider: "provider|one" })
  );
});

test("object key order and request-only metadata preserve legitimate retry identity", async () => {
  const body = {
    ...original,
    input: [{ role: "user", content: "hello" }],
    tools: [{ type: "function", function: { name: "lookup", strict: true } }],
    generationConfig: { temperature: 0, topP: 1 },
    metadata: { trace: "first" },
    api_key: "credential-first",
  };
  const first = await lookup(body);
  saveIdempotency(first.idempotencyKey, panelResponse, 200, 12_000);
  const retry = await lookup({
    generationConfig: { topP: 1, temperature: 0 },
    tools: [{ function: { strict: true, name: "lookup" }, type: "function" }],
    input: [{ content: "hello", role: "user" }],
    reasoning_effort: "low",
    temperature: 0,
    messages: original.messages,
    api_key: "credential-second",
    metadata: { trace: "second" },
  });
  assert.equal(retry.idempotencyKey, first.idempotencyKey);
  assert.ok(retry.hit);
  assert.ok(!retry.idempotencyKey?.includes("credential-first"));
});

test("unserializable generation contracts bypass read and write instead of sharing a digest", async () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  for (const options of [circular, { outputLimit: 1n }]) {
    const result = await lookup({ ...original, options });
    assert.equal(result.hit, null);
    assert.equal(result.idempotencyKey, null);
  }
  const missingHeader = await lookup(original, { clientRawRequest: { headers: new Headers() } });
  assert.equal(missingHeader.idempotencyKey, null);
});
