import assert from "node:assert/strict";
import test from "node:test";

import { buildModelInfo } from "../../src/app/api/v1/models/info/modelInfo.ts";

test("model info maps catalog modalities to their real endpoints", () => {
  const models = [
    { id: "openai/gpt-4o", name: "GPT-4o", owned_by: "openai", contextWindow: 128000 },
    { id: "elevenlabs/eleven_multilingual_v2", type: "audio", subtype: "speech" },
    { id: "deepgram/nova-3", type: "audio", subtype: "transcription" },
    { id: "typesafe-ai/jev-latest", type: "systemone", name: "JEV Latest" },
    { id: "xai/grok-imagine-video", type: "video" },
  ];

  assert.deepEqual(buildModelInfo(models, "openai/gpt-4o"), {
    id: "openai/gpt-4o",
    name: "GPT-4o",
    kind: "llm",
    owned_by: "openai",
    endpoint: "/v1/chat/completions",
    contextWindow: 128000,
  });
  assert.equal(
    buildModelInfo(models, "elevenlabs/eleven_multilingual_v2")?.endpoint,
    "/v1/audio/speech"
  );
  assert.equal(
    buildModelInfo(models, "elevenlabs/eleven_multilingual_v2")?.voicesUrl,
    "/v1/audio/voices?provider=elevenlabs"
  );
  assert.equal(buildModelInfo(models, "deepgram/nova-3")?.endpoint, "/v1/audio/transcriptions");
  assert.equal(buildModelInfo(models, "typesafe-ai/jev-latest")?.endpoint, "/v1/systemone");
  assert.equal(
    buildModelInfo(models, "xai/grok-imagine-video")?.endpoint,
    "/v1/videos/generations"
  );
});

test("model info advertises only implemented fetch and voice discovery routes", () => {
  const models = [
    {
      id: "exa-search/search",
      type: "webSearch",
      searchTypes: ["web", "news"],
      maxResults: 100,
    },
    { id: "exa-search/fetch", type: "webFetch", params: ["url", "format", "max_characters"] },
    { id: "edge-tts/edge-tts", type: "audio", subtype: "speech" },
    { id: "local-device/local-tts", type: "audio", subtype: "speech" },
  ];

  assert.equal(buildModelInfo(models, "exa-search/fetch")?.endpoint, "/v1/web/fetch");
  assert.equal(buildModelInfo(models, "exa-search/search")?.endpoint, "/v1/search");
  assert.deepEqual(buildModelInfo(models, "exa-search/search")?.searchTypes, ["web", "news"]);
  assert.equal(buildModelInfo(models, "exa-search/search")?.maxResults, 100);
  assert.equal(
    buildModelInfo(models, "edge-tts/edge-tts")?.voicesUrl,
    "/v1/audio/voices?provider=edge-tts"
  );
  assert.equal(buildModelInfo(models, "local-device/local-tts")?.voicesUrl, undefined);
});

test("model info disambiguates duplicate ids by kind and excludes hidden ids", () => {
  const models = [
    { id: "google/gemini-2.5-pro", type: "audio", subtype: "transcription" },
    { id: "google/gemini-2.5-pro", type: "chat" },
  ];
  assert.equal(buildModelInfo(models, "google/gemini-2.5-pro", "stt")?.kind, "stt");
  assert.equal(buildModelInfo(models, "google/gemini-2.5-pro", "llm")?.kind, "llm");
  assert.equal(buildModelInfo(models, "google/gemini-2.5-pro", "image"), null);
  assert.equal(buildModelInfo(models, "missing/model"), null);
});
