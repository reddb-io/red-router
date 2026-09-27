import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ConsoleLogTail } from "../../src/lib/consoleLogTail.ts";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-console-tail-"));
const file = path.join(directory, "app.log");
const now = Date.UTC(2026, 8, 27, 3, 0, 0);
const line = (message: string, level: number, time = now) =>
  JSON.stringify({ time: new Date(time).toISOString(), level, msg: message }) + "\n";

test.after(() => fs.rmSync(directory, { recursive: true, force: true }));

test("console tail sends a filtered snapshot, then only complete appended lines", async () => {
  fs.writeFileSync(
    file,
    line("old", 50, now - 2 * 60 * 60 * 1000) +
      line("info", 30) +
      line("warn", 40) +
      line("error", 50)
  );
  const tail = new ConsoleLogTail(file, { level: "warn" }, 2);

  const snapshot = await tail.poll(now);
  assert.equal(snapshot?.type, "snapshot");
  assert.deepEqual(
    snapshot?.logs.map((entry) => entry.msg),
    ["warn", "error"]
  );
  assert.equal(await tail.poll(now), null);

  const next = line("later", 40);
  fs.appendFileSync(file, next.slice(0, -2));
  assert.equal(await tail.poll(now), null);
  fs.appendFileSync(file, next.slice(-2));
  const append = await tail.poll(now);
  assert.equal(append?.type, "append");
  assert.deepEqual(
    append?.logs.map((entry) => entry.msg),
    ["later"]
  );
});

test("console tail resets after truncation, rotation, and temporary absence", async () => {
  fs.writeFileSync(file, line("before", 40) + line("padding", 40) + line("more", 40));
  const tail = new ConsoleLogTail(file);
  assert.equal((await tail.poll(now))?.type, "snapshot");

  fs.writeFileSync(file, line("short", 50));
  assert.deepEqual(
    (await tail.poll(now))?.logs.map((entry) => entry.msg),
    ["short"]
  );

  const rotated = path.join(directory, "rotated.log");
  fs.renameSync(file, rotated);
  fs.writeFileSync(file, line("new file", 40));
  assert.deepEqual(
    (await tail.poll(now))?.logs.map((entry) => entry.msg),
    ["new file"]
  );

  fs.unlinkSync(file);
  assert.deepEqual(await tail.poll(now), { type: "snapshot", logs: [] });
  assert.equal(await tail.poll(now), null);
});

test("console tail snapshots a bounded suffix of a large log without parsing a cut line", async () => {
  fs.writeFileSync(
    file,
    line("discarded", 40) + "x".repeat(17 * 1024 * 1024) + "\n" + line("latest", 50)
  );
  const tail = new ConsoleLogTail(file);
  const snapshot = await tail.poll(now);
  assert.deepEqual(
    snapshot?.logs.map((entry) => entry.msg),
    ["latest"]
  );
});
