import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { NextRequest } from "next/server";

import { updateSettings } from "../../src/lib/db/settings";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-console-stream-"));
const file = path.join(directory, "app.log");
const originalLogPath = process.env.APP_LOG_FILE_PATH;
process.env.APP_LOG_FILE_PATH = file;

const { GET } = await import("../../src/app/api/logs/console/stream/route.ts");

test.before(async () => updateSettings({ requireLogin: false }));
test.after(async () => {
  await updateSettings({ requireLogin: true });
  if (originalLogPath === undefined) delete process.env.APP_LOG_FILE_PATH;
  else process.env.APP_LOG_FILE_PATH = originalLogPath;
  fs.rmSync(directory, { recursive: true, force: true });
});

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out waiting for console SSE")), 8_000);
      }),
    ]);
    return new TextDecoder().decode(result.value);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test("console stream validates filters before opening a response", async () => {
  const response = await GET(
    new NextRequest("http://localhost/api/logs/console/stream?level=bogus")
  );
  assert.equal(response.status, 400);
  assert.doesNotMatch(await response.text(), /at \/|stack/i);
});

test("console stream sends a snapshot and appended structured log entries", async () => {
  fs.writeFileSync(
    file,
    JSON.stringify({ time: new Date().toISOString(), level: 30, msg: "initial line" }) + "\n"
  );
  const abort = new AbortController();
  const request = new NextRequest("http://localhost/api/logs/console/stream", {
    signal: abort.signal,
  });
  const response = await GET(request);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /text\/event-stream/);
  const reader = response.body!.getReader();

  try {
    const initial = await readChunk(reader);
    assert.match(initial, /"type":"snapshot"/);
    assert.match(initial, /initial line/);

    fs.appendFileSync(
      file,
      JSON.stringify({ time: new Date().toISOString(), level: 40, msg: "appended line" }) + "\n"
    );
    const appended = await readChunk(reader);
    assert.match(appended, /"type":"append"/);
    assert.match(appended, /appended line/);
  } finally {
    abort.abort();
    await reader.cancel().catch(() => undefined);
  }
});
