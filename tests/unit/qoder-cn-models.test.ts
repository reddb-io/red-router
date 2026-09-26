import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  clearQoderCnModelCacheForTest,
  getQoderCnModelConfig,
  resolveQoderCnModels,
} from "../../open-sse/services/qoderCnModels.ts";
import { clearQoderCnPatCacheForTest } from "../../open-sse/services/qoderCnPat.ts";

const credential = {
  token: "dt-cn-catalog",
  userId: "cn-user",
  machineId: randomUUID(),
};
const catalogBody = {
  chat: [
    {
      key: "qmodel_latest",
      display_name: "Qwen3.7-Max",
      max_input_tokens: 200_000,
      max_output_tokens: 8_192,
      is_reasoning: true,
      context_config: { levels: ["200k", "400k"] },
    },
    { key: "hidden-model", display_name: "Hidden", enable: false },
  ],
};

test("Qoder CN fetches a COSY-signed account catalog and preserves exact model configs", async () => {
  clearQoderCnModelCacheForTest();
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Response.json(catalogBody);
  };
  try {
    const result = await resolveQoderCnModels(credential, { fetchImpl });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://gateway.qoder.com.cn/algo/api/v2/model/list");
    const headers = calls[0].init.headers as Record<string, string>;
    assert.match(headers.Authorization, /^Bearer COSY\./);
    assert.equal(headers["Cosy-User"], "cn-user");
    assert.equal(headers["Cosy-Machineid"], credential.machineId);
    assert.equal(result.models.length, 2);
    assert.equal(result.models[0].contextLength, 200_000);
    assert.equal(result.models[0].supportsReasoning, true);
    assert.equal(result.models[1].hidden, true);
    assert.deepEqual(result.rawConfigs.get("qmodel_latest")?.context_config, {
      levels: ["200k", "400k"],
    });
    assert.deepEqual(
      (await getQoderCnModelConfig(credential, "qmodel_latest", { fetchImpl })).context_config,
      { levels: ["200k", "400k"] }
    );
    assert.equal(calls.length, 1, "catalog should be cached for the same connection");
  } finally {
    clearQoderCnModelCacheForTest();
  }
});

test("Qoder CN refuses to guess a missing model config after a live refresh", async () => {
  clearQoderCnModelCacheForTest();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return Response.json(catalogBody);
  };
  try {
    await assert.rejects(
      () => getQoderCnModelConfig(credential, "unknown-model", { fetchImpl }),
      /model config is unavailable/
    );
    assert.equal(calls, 2);
  } finally {
    clearQoderCnModelCacheForTest();
  }
});

test("Qoder CN PAT model-list never sends a raw PAT to the signed gateway", async () => {
  clearQoderCnModelCacheForTest();
  clearQoderCnPatCacheForTest();
  const calls: string[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push(url);
    if (url.includes("jobToken/exchange")) return Response.json({ token: "jt-cn-model" });
    if (url.includes("userinfo")) return Response.json({ id: "cn-pat-user" });
    const headers = init.headers as Record<string, string>;
    assert.equal(headers["Cosy-User"], "cn-pat-user");
    assert.doesNotMatch(headers.Authorization, /pt-cn-model/);
    return Response.json(catalogBody);
  };
  try {
    const result = await resolveQoderCnModels({ token: "pt-cn-model" }, { fetchImpl });
    assert.equal(result.models[0].id, "qmodel_latest");
    assert.deepEqual(calls, [
      "https://openapi.qoder.com.cn/api/v1/jobToken/exchange",
      "https://openapi.qoder.com.cn/api/v1/userinfo",
      "https://gateway.qoder.com.cn/algo/api/v2/model/list",
    ]);
  } finally {
    clearQoderCnModelCacheForTest();
    clearQoderCnPatCacheForTest();
  }
});

test("Qoder CN model-list errors do not disclose upstream bodies", async () => {
  clearQoderCnModelCacheForTest();
  const fetchImpl = async () => new Response("dt-secret at /srv/private", { status: 403 });
  try {
    await assert.rejects(
      () => resolveQoderCnModels(credential, { fetchImpl }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /HTTP 403/);
        assert.doesNotMatch(error.message, /dt-secret|\/srv\/private/);
        return true;
      }
    );
  } finally {
    clearQoderCnModelCacheForTest();
  }
});

test("Qoder CN model-list rejects malformed or oversized catalogs", async () => {
  clearQoderCnModelCacheForTest();
  try {
    await assert.rejects(
      () =>
        resolveQoderCnModels(credential, { fetchImpl: async () => Response.json({ chat: {} }) }),
      /invalid shape/
    );
    await assert.rejects(
      () =>
        resolveQoderCnModels(credential, {
          fetchImpl: async () => Response.json({ chat: [{ key: "x".repeat(2 * 1024 * 1024) }] }),
        }),
      /exceeded limit/
    );
  } finally {
    clearQoderCnModelCacheForTest();
  }
});
