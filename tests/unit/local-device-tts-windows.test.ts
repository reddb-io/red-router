import assert from "node:assert/strict";
import test from "node:test";

import { buildWindowsSapiInvocation } from "../../open-sse/executors/localDevice.ts";
import { parseWindowsLocalDeviceVoices } from "../../src/lib/audio/localDeviceVoices.ts";

test("Windows SAPI invocation keeps user text and voice outside PowerShell source", () => {
  const text = "Hello'; Start-Process calc; #";
  const voice = "Microsoft Zira'; Write-Host secret; #";
  const output = "C:\\Temp\\voice.wav";
  const invocation = buildWindowsSapiInvocation(text, voice, output);

  assert.equal(invocation.command, "powershell.exe");
  assert.equal(invocation.args[0], "-NoProfile");
  assert.equal(invocation.args[1], "-NonInteractive");
  assert.equal(invocation.args.includes("-Command"), true);
  assert.equal(invocation.args.join(" ").includes(text), false);
  assert.equal(invocation.args.join(" ").includes(voice), false);
  assert.equal(invocation.args.join(" ").includes(output), false);
  assert.equal(invocation.options.env.OMNIROUTE_TTS_TEXT, text);
  assert.equal(invocation.options.env.OMNIROUTE_TTS_VOICE, voice);
  assert.equal(invocation.options.env.OMNIROUTE_TTS_OUTPUT, output);
  assert.equal(invocation.options.timeout, 60_000);
});

test("Windows SAPI voice JSON supports a single installed voice", () => {
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
});
