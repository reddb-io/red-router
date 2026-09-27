import assert from "node:assert/strict";
import test from "node:test";

import { REGISTRY } from "../../open-sse/config/providers/index.ts";
import { APIKEY_PROVIDERS } from "../../src/shared/constants/providers/apikey/index.ts";

test("Atria keeps its case-sensitive text-only preview id", () => {
  const provider = REGISTRY.atria;
  assert.equal(provider.baseUrl, "https://api.atria-asi.ai/v1/chat/completions");
  assert.deepEqual(
    provider.models.map((model) => model.id),
    ["Atria-Dawn-Preview"]
  );
  assert.equal(provider.models[0].supportsVision, undefined);
  assert.equal(APIKEY_PROVIDERS.atria.id, "atria");
});

test("Token Harbor keeps bare upstream ids and accepts its rotating catalog", () => {
  const provider = REGISTRY.tokenharbor;
  assert.equal(provider.baseUrl, "https://tokenharbor.ai/v1/chat/completions");
  assert.equal(provider.modelsUrl, "https://tokenharbor.ai/v1/models");
  assert.equal(provider.passthroughModels, true);
  assert.ok(provider.models.some((model) => model.id === "deepseek-v4.1-flash:free"));
  assert.equal(APIKEY_PROVIDERS.tokenharbor.id, "tokenharbor");
});

test("Alibaba key products retain distinct upstream hosts and model inventories", () => {
  const plans = [
    {
      id: "alicode",
      url: "https://coding.dashscope.aliyuncs.com/v1/chat/completions",
      model: "qwen3-max-2026-01-23",
    },
    {
      id: "alicode-intl",
      url: "https://coding-intl.dashscope.aliyuncs.com/v1/chat/completions",
      model: "qwen3-coder-plus",
    },
    {
      id: "alims-intl",
      url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
      model: "qwen3.5-plus",
    },
    {
      id: "alitp-intl",
      url: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
      model: "deepseek-v4-pro",
    },
  ];
  for (const { id, url, model } of plans) {
    const provider = REGISTRY[id];
    assert.equal(provider.baseUrl, url, id);
    assert.equal(provider.format, "openai", id);
    assert.equal(provider.authType, "apikey", id);
    assert.equal(provider.authHeader, "bearer", id);
    assert.ok(
      provider.models?.some((entry) => entry.id === model),
      id
    );
    assert.equal(APIKEY_PROVIDERS[id].id, id);
  }
  assert.notEqual(REGISTRY["alitp-intl"].baseUrl, REGISTRY["bailian-coding-plan"].baseUrl);
});

test("Featherless alias retains old models and exposes 9router's current catalog", () => {
  const provider = REGISTRY["featherless-ai"];
  assert.equal(provider.alias, "featherless");
  assert.equal(provider.modelsUrl, "https://api.featherless.ai/v1/models");
  assert.equal(provider.passthroughModels, true);
  for (const id of [
    "featherless-ai/Qwerky-72B",
    "deepseek-ai/DeepSeek-V4-Pro",
    "zai-org/GLM-5.2",
    "moonshotai/Kimi-K2.7-Code",
  ]) {
    assert.ok(
      provider.models?.some((model) => model.id === id),
      id
    );
  }
});
