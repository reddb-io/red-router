import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CODEX_CLIENT_VERSION } from "../../../src/shared/constants/codexClient.ts";
import { CodexExecutor } from "../../../open-sse/executors/codex.ts";
import { normalizeResponsesReasoningEffort } from "../../../open-sse/translator/request/openai-responses/helpers.ts";
import {
  fetchCodexDiscoveryModels,
  reconcileCodexDiscoveryCatalog,
} from "../../../src/app/api/providers/[id]/models/discovery/codex.ts";

test("Codex discovery uses the current client identity and retains a new upstream-native model ID", async () => {
  const previous = process.env.CODEX_CLIENT_VERSION;
  delete process.env.CODEX_CLIENT_VERSION;
  try {
    const models = await fetchCodexDiscoveryModels({
      accessToken: "fixture-only-token",
      fetchImpl: async (url, init) => {
        assert.equal(new URL(url).searchParams.get("client_version"), DEFAULT_CODEX_CLIENT_VERSION);
        assert.equal(init.headers.Version, DEFAULT_CODEX_CLIENT_VERSION);
        assert.ok(init.headers["User-Agent"].includes(DEFAULT_CODEX_CLIENT_VERSION));
        return Response.json({
          models: [
            {
              slug: "gpt-6.1-sol",
              display_name: "GPT-6.1-Sol",
              visibility: "list",
              supported_in_api: true,
              max_context_window: 872000,
              context_window: 272000,
              input_modalities: ["text", "image"],
              supported_reasoning_levels: [{ effort: "high" }, { effort: "ultra" }],
            },
          ],
        });
      },
    });
    assert.ok(models);
    const catalog = reconcileCodexDiscoveryCatalog(models, [], "safe");
    assert.equal(catalog.activeModels[0].id, "gpt-6.1-sol");
    assert.equal(catalog.activeModels[0].inputTokenLimit, 872000);
    assert.deepEqual(catalog.activeModels[0].supportedThinkingEfforts, ["high", "ultra"]);
    assert.equal(catalog.activeModels[0].supportsVision, true);
    assert.equal(catalog.candidateModels.length, 0);
  } finally {
    if (previous === undefined) delete process.env.CODEX_CLIENT_VERSION;
    else process.env.CODEX_CLIENT_VERSION = previous;
  }
});

test("GPT 6.1 Sol preserves native max effort through Responses translation and Codex dispatch", () => {
  const executor = new CodexExecutor();
  for (const model of ["gpt-6.1-sol", "codex/gpt-6.1-sol", "cx/gpt-6.1-sol"]) {
    assert.equal(normalizeResponsesReasoningEffort("max", model), "max");
  }
  for (const effort of ["max", "ultra"]) {
    const result = executor.transformRequest(
      "gpt-6.1-sol",
      {
        model: "gpt-6.1-sol",
        input: [{ role: "user", content: "hello" }],
        reasoning: { effort },
      },
      false,
      { requestEndpointPath: "/responses" }
    );
    assert.equal(result.model, "gpt-6.1-sol");
    // Codex's ultra mode coordinates delegation; its upstream wire effort is max.
    assert.equal(result.reasoning.effort, "max");
  }
  assert.equal(normalizeResponsesReasoningEffort("max", "gpt-6.1-astra"), "xhigh");
});
