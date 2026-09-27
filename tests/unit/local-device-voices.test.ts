import assert from "node:assert/strict";
import test from "node:test";

import {
  parseMacLocalDeviceVoices,
  parseWindowsLocalDeviceVoices,
} from "../../src/lib/audio/localDeviceVoices.ts";
import { canUseHostSpeech } from "../../src/lib/security/hostSpeechAccess.ts";
import { isLocalOnlyPath } from "../../src/server/authz/routeGuard.ts";
import { SPAWN_CAPABLE_PREFIXES } from "../../src/shared/constants/spawnCapablePrefixes.ts";

test("macOS voice discovery yields usable speech model and voice fields", () => {
  const voices = parseMacLocalDeviceVoices(
    "Samantha               en_US    # Hello\n" +
      "Daniel                 en_GB    # Hello\n" +
      "Samantha               en_US    # duplicate\n" +
      "malformed line\n"
  );
  assert.deepEqual(voices, [
    {
      id: "Samantha",
      name: "Samantha",
      locale: "en-US",
      lang: "en",
      gender: "",
      model: "local-device/default",
      voice: "Samantha",
    },
    {
      id: "Daniel",
      name: "Daniel",
      locale: "en-GB",
      lang: "en",
      gender: "",
      model: "local-device/default",
      voice: "Daniel",
    },
  ]);
});

test("Windows SAPI discovery handles a single voice and rejects malformed rows", () => {
  assert.deepEqual(
    parseWindowsLocalDeviceVoices(
      JSON.stringify({ Name: "Microsoft Zira Desktop", Culture: "en-US", Gender: "Female" })
    ),
    [
      {
        id: "Microsoft Zira Desktop",
        name: "Microsoft Zira Desktop",
        locale: "en-US",
        lang: "en",
        gender: "Female",
        model: "local-device/default",
        voice: "Microsoft Zira Desktop",
      },
    ]
  );
  assert.deepEqual(
    parseWindowsLocalDeviceVoices(
      JSON.stringify([
        { Name: "", Culture: "en-US" },
        { Name: "Bad", Culture: "not-a-locale" },
      ])
    ),
    []
  );
});

test("host voice route is local-only and can never receive manage-scope bypass", () => {
  assert.equal(isLocalOnlyPath("/api/local/audio/voices", "GET"), true);
  assert.ok(SPAWN_CAPABLE_PREFIXES.includes("/api/local/"));
  assert.equal(isLocalOnlyPath("/api/v1/audio/voices", "GET"), false);
});

test("host voice route rejects an unstamped request before spawning", async () => {
  const previous = process.env.OMNIROUTE_PEER_STAMP_TOKEN;
  process.env.OMNIROUTE_PEER_STAMP_TOKEN = "unit-test-peer-stamp-token";
  try {
    const request = new Request("http://localhost/api/local/audio/voices", {
      headers: { Host: "localhost" },
    });
    assert.equal(canUseHostSpeech(request), false);
    const route = await import("../../src/app/api/local/audio/voices/route.ts");
    const response = await route.GET(request);
    assert.equal(response.status, 403);
  } finally {
    if (previous === undefined) delete process.env.OMNIROUTE_PEER_STAMP_TOKEN;
    else process.env.OMNIROUTE_PEER_STAMP_TOKEN = previous;
  }
});
