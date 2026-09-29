import assert from "node:assert/strict";
import test from "node:test";

const { resolveChatCoreTargetFormat, usesOpenRouterMessages } = await import(
  "../../../open-sse/handlers/chatCore/targetFormat.ts"
);
const { resolveExecutionCredentials } = await import(
  "../../../open-sse/handlers/chatCore/executionCredentials.ts"
);
const { DefaultExecutor } = await import("../../../open-sse/executors/default.ts");
const { FORMATS } = await import("../../../open-sse/translator/formats.ts");

const resolve = (over: Record<string, unknown>) =>
  resolveChatCoreTargetFormat({
    provider: "openrouter",
    resolvedModel: "anthropic/claude-sonnet-4.5",
    apiFormat: undefined,
    sourceFormat: FORMATS.CLAUDE,
    customModelTargetFormat: undefined,
    providerSpecificData: {},
    ...over,
  } as never);

test("a Claude-format client asking OpenRouter for an Anthropic model stays in Messages format", () => {
  assert.equal(resolve({}).targetFormat, FORMATS.CLAUDE);
  assert.equal(usesOpenRouterMessages("openrouter", "anthropic/claude-opus-4", FORMATS.CLAUDE), true);
});

test("everything else on OpenRouter keeps chat completions", () => {
  assert.equal(resolve({ sourceFormat: FORMATS.OPENAI }).targetFormat, FORMATS.OPENAI);
  assert.equal(resolve({ resolvedModel: "openai/gpt-5" }).targetFormat, FORMATS.OPENAI);
  assert.equal(resolve({ provider: "openai" }).targetFormat === FORMATS.CLAUDE, false);
});

const executor = () => new DefaultExecutor("openrouter");
const creds = (psd: Record<string, unknown> = {}) => ({ apiKey: "sk-or-test", providerSpecificData: psd });

test("the marker sends the request to /api/v1/messages with the API version header", () => {
  const credentials = resolveExecutionCredentials({
    credentials: creds() as never,
    nativeCodexPassthrough: false,
    endpointPath: "/v1/messages",
    targetFormat: FORMATS.CLAUDE,
    provider: "openrouter",
    ccSessionId: null,
  }) as ReturnType<typeof creds>;
  assert.equal(credentials.providerSpecificData._redRouterOpenRouterMessages, true);
  assert.equal(credentials.providerSpecificData.disableStreamOptions, true);

  const exec = executor();
  assert.equal(
    exec.buildUrl("anthropic/claude-sonnet-4.5", true, 0, credentials as never),
    "https://openrouter.ai/api/v1/messages"
  );
  const headers = exec.buildHeaders(credentials as never, true) as Record<string, string>;
  assert.equal(headers["anthropic-version"], "2023-06-01");
  assert.match(headers.Authorization ?? headers["x-api-key"] ?? "", /sk-or-test/);
});

test("without the marker the URL is still chat/completions", () => {
  assert.equal(
    executor().buildUrl("anthropic/claude-sonnet-4.5", true, 0, creds() as never),
    "https://openrouter.ai/api/v1/chat/completions"
  );
});
