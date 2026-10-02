import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";

// Scratch install with no login and no API-key requirement; a real minimax connection is stored
// so the route's own credential lookup runs, only the MiniMax network call is mocked.
const dataDir = mkdtempSync(join(tmpdir(), "redrouter-minimax-voices-"));
process.env.DATA_DIR = dataDir;
process.env.API_KEY_SECRET = "minimax-voices-api-key-secret";
process.env.REQUIRE_API_KEY = "false";

const { resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { createProviderConnection } = await import("../../../src/lib/db/providers.ts");
const { normalizeVoices } = await import("../../../src/app/api/v1/audio/voices/voiceCatalog.ts");
const route = await import("../../../src/app/api/v1/audio/voices/route.ts");

const originalFetch = globalThis.fetch;
let outbound: Array<{ url: string; init?: RequestInit }> = [];

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  outbound = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    outbound.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

after(() => {
  resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

const KEY = "mm-secret-key-123";
const PAYLOAD = {
  system_voice: [
    { voice_id: "English_expressive_narrator", voice_name: "Expressive Narrator" },
    { voice_id: "Chinese (Mandarin)_female_beijing", voice_name: "Female Beijing" },
    { voice_id: "English_expressive_narrator", voice_name: "duplicate" },
  ],
  voice_cloning: [{ voice_id: "clone_123", voice_name: "My Voice" }],
  voice_generation: [{ voiceId: "gen_9" }],
  music_generation: [{ voice_id: "song_1", voice_name: "Song" }, { voice_name: "no id" }],
  base_resp: { status_code: 0, status_msg: "success" },
};
const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const get = (query: string) => route.GET(new Request(`http://localhost/v1/audio/voices?${query}`));

test("normalizer groups system voices by inferred language and tags the custom groups", () => {
  const voices = normalizeVoices("minimax", PAYLOAD);
  assert.deepEqual(
    voices.map((voice) => [voice.id, voice.lang]),
    [
      ["English_expressive_narrator", "en"],
      ["Chinese (Mandarin)_female_beijing", "zh"],
      // Custom voices come last, ordered by display name.
      ["gen_9", "custom"],
      ["clone_123", "custom"],
      ["song_1", "custom"],
    ]
  );
  const byId = Object.fromEntries(voices.map((voice) => [voice.id, voice]));
  assert.equal(byId.clone_123.name, "My Voice · Cloned");
  assert.equal(byId.gen_9.name, "gen_9 · Generated");
  assert.equal(byId.song_1.name, "Song · Music");
  assert.equal(byId["Chinese (Mandarin)_female_beijing"].gender, "female");
  assert.equal(byId.English_expressive_narrator.name, "Expressive Narrator");
  // Same entry shape the other providers return.
  assert.deepEqual(Object.keys(voices[0]).sort(), [
    "gender",
    "id",
    "lang",
    "model",
    "name",
    "voice",
  ]);
  assert.equal(voices[0].model, "minimax/speech-2.8-hd");
  assert.equal(voices.filter((voice) => voice.id === "English_expressive_narrator").length, 1);
});

test("normalizer rejects malformed payloads and MiniMax error envelopes", () => {
  assert.throws(() => normalizeVoices("minimax", "nope"));
  assert.throws(() =>
    normalizeVoices("minimax-cn", {
      base_resp: { status_code: 1004, status_msg: "bad key sk-abc" },
    })
  );
});

test("route without a stored connection answers 401 and makes no outbound call", async () => {
  mockFetch(() => ok(PAYLOAD));
  const res = await get("provider=minimax");
  assert.equal(res.status, 401);
  assert.equal(outbound.length, 0);
});

test("route lists global MiniMax voices with a POST, the stored key and a timeout", async () => {
  await createProviderConnection({
    provider: "minimax",
    authType: "apikey",
    isActive: true,
    name: "mm",
    apiKey: KEY,
  });
  mockFetch(() => ok(PAYLOAD));

  const res = await get("provider=minimax");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.object, "list");
  assert.equal(body.data.length, 5);
  assert.ok(!JSON.stringify(body).includes(KEY));

  assert.equal(outbound.length, 1);
  assert.equal(outbound[0].url, "https://api.minimax.io/v1/get_voice");
  assert.equal(outbound[0].init?.method, "POST");
  assert.equal(outbound[0].init?.body, JSON.stringify({ voice_type: "all" }));
  const headers = outbound[0].init?.headers as Headers;
  assert.equal(headers.get("Authorization"), `Bearer ${KEY}`);
  assert.equal(headers.get("Content-Type"), "application/json");
  assert.ok(outbound[0].init?.signal, "upstream call must carry an abort signal");
});

test("route filters by language and forwards voice_type", async () => {
  mockFetch(() => ok(PAYLOAD));
  const res = await get("provider=minimax&lang=zh&voice_type=system");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(
    body.data.map((voice: { id: string }) => voice.id),
    ["Chinese (Mandarin)_female_beijing"]
  );
  assert.equal(outbound[0].init?.body, JSON.stringify({ voice_type: "system" }));

  const bad = await get("provider=minimax&voice_type=everything");
  assert.equal(bad.status, 400);
});

test("minimax-cn uses the China endpoint and its own connection", async () => {
  mockFetch(() => ok(PAYLOAD));
  assert.equal((await get("provider=minimax-cn")).status, 401);
  assert.equal(outbound.length, 0);

  await createProviderConnection({
    provider: "minimax-cn",
    authType: "apikey",
    isActive: true,
    name: "mm-cn",
    apiKey: "cn-key-456",
  });
  const res = await get("provider=minimax-cn");
  assert.equal(res.status, 200);
  assert.equal(outbound[0].url, "https://api.minimaxi.com/v1/get_voice");
  assert.equal((outbound[0].init?.headers as Headers).get("Authorization"), "Bearer cn-key-456");
});

test("upstream failures never echo upstream text or keys", async () => {
  const secretText = `boom for ${KEY} at /srv/app/index.js`;
  for (const respond of [
    () => new Response(secretText, { status: 500 }),
    () => ok({ base_resp: { status_code: 1004, status_msg: secretText } }),
    () => {
      throw new Error(secretText);
    },
  ]) {
    mockFetch(respond);
    const res = await get("provider=minimax");
    assert.equal(res.status, 502);
    const text = await res.text();
    assert.ok(!text.includes(KEY), text);
    assert.ok(!text.includes("/srv/app"), text);
  }
});
