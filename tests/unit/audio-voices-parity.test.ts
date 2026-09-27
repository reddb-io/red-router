import assert from "node:assert/strict";
import test from "node:test";

import { createTempDataDir } from "../_setup/tempDataDir.ts";
import { normalizeVoices } from "../../src/app/api/v1/audio/voices/voiceCatalog.ts";

const { cleanup } = createTempDataDir("omniroute-audio-voices-");
const previousRequireApiKey = process.env.REQUIRE_API_KEY;
process.env.REQUIRE_API_KEY = "false";
test.after(async () => {
  if (previousRequireApiKey === undefined) delete process.env.REQUIRE_API_KEY;
  else process.env.REQUIRE_API_KEY = previousRequireApiKey;
  await cleanup();
});

test("voice catalogs preserve voice IDs and advertise usable speech parameters", () => {
  assert.deepEqual(
    normalizeVoices("deepgram", {
      tts: [{ canonical_name: "aura-2-thalia-en", name: "Thalia", languages: ["en"] }],
    }),
    [
      {
        id: "aura-2-thalia-en",
        name: "Thalia",
        lang: "en",
        gender: "",
        model: "dg/aura-2-thalia-en",
        voice: "aura-2-thalia-en",
      },
    ]
  );

  const inworld = normalizeVoices("inworld", {
    voices: [{ voiceId: "luna", displayName: "Luna", languages: ["en", "es"] }],
  });
  assert.equal(inworld[0]?.model.endsWith("/inworld-tts-2"), true);
  assert.equal(inworld[0]?.voice, "luna");
  assert.equal(inworld[0]?.lang, "en");
  assert.equal(inworld[1]?.lang, "es");

  const elevenlabs = normalizeVoices("elevenlabs", {
    voices: [
      { voice_id: "voice_123", name: "Rachel", labels: { language: "en", gender: "female" } },
    ],
  });
  assert.equal(elevenlabs[0]?.model.endsWith("/eleven_multilingual_v2"), true);
  assert.equal(elevenlabs[0]?.voice, "voice_123");
});

test("edge catalog rejects malformed data and normalizes locale", () => {
  assert.throws(() => normalizeVoices("edge-tts", { error: "bad" }));
  const voices = normalizeVoices("edge-tts", [
    { ShortName: "en-US-AvaNeural", FriendlyName: "Ava", Locale: "en-US", Gender: "Female" },
  ]);
  assert.equal(voices[0]?.voice, "en-US-AvaNeural");
  assert.equal(voices[0]?.lang, "en");
});

test("route rejects local-device discovery before any host subprocess is reached", async () => {
  const route = await import("../../src/app/api/v1/audio/voices/route.ts");
  const response = await route.GET(
    new Request("http://localhost/v1/audio/voices?provider=local-device")
  );
  assert.equal(response.status, 501);
  assert.match(await response.text(), /Local-device voice discovery is unavailable/);
});
