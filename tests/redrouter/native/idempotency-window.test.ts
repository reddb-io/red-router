import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

const directory = mkdtempSync(join(tmpdir(), "redrouter-idempotency-window-"));
process.env.DATA_DIR = directory;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const { getSettings, updateSettings } = await import("../../../src/lib/db/settings.ts");
const { resetDbInstance } = await import("../../../src/lib/db/core.ts");
const {
  checkIdempotency,
  clearIdempotency,
  DEFAULT_IDEMPOTENCY_WINDOW_MS,
  getIdempotencyStats,
  resolveIdempotencyWindowMs,
  saveIdempotency,
} = await import("../../../src/lib/idempotencyLayer.ts");

const response = { id: "original-response", choices: [{ message: { content: "answer" } }] };
const now = 1_800_000_000_000;

beforeEach(async () => {
  clearIdempotency();
  await updateSettings({ idempotencyWindowMs: DEFAULT_IDEMPOTENCY_WINDOW_MS });
});

after(() => {
  clearIdempotency();
  resetDbInstance();
  rmSync(directory, { recursive: true, force: true });
});

test("configured replay window and reported window agree beyond the old five seconds", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  await updateSettings({ idempotencyWindowMs: 12_000 });
  const settings = await getSettings();
  saveIdempotency("retry", response, 200, resolveIdempotencyWindowMs(settings.idempotencyWindowMs));

  t.mock.timers.tick(5001);
  assert.deepEqual(checkIdempotency("retry"), { response, status: 200 });
  assert.deepEqual(await getIdempotencyStats(), { activeKeys: 1, windowMs: 12_000 });

  t.mock.timers.tick(6999);
  // Stats must not include expired keys waiting for the thirty-second sweeper.
  assert.deepEqual(await getIdempotencyStats(), { activeKeys: 0, windowMs: 12_000 });
  assert.equal(checkIdempotency("retry"), null);
});

test("a configured short window expires exactly at the advertised boundary", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  await updateSettings({ idempotencyWindowMs: 2000 });
  const settings = await getSettings();
  saveIdempotency("short", response, 201, settings.idempotencyWindowMs);

  t.mock.timers.tick(1999);
  assert.deepEqual(checkIdempotency("short"), { response, status: 201 });
  t.mock.timers.tick(1);
  assert.deepEqual(await getIdempotencyStats(), { activeKeys: 0, windowMs: 2000 });
});

test("invalid windows cannot retain a replay forever or report a different effective value", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  const invalid = [undefined, null, "9000", NaN, Infinity, -Infinity, 0, -10];
  for (const [index, value] of invalid.entries()) {
    assert.equal(resolveIdempotencyWindowMs(value), DEFAULT_IDEMPOTENCY_WINDOW_MS);
    saveIdempotency(`invalid-${index}`, response, 200, value);
  }
  await updateSettings({ idempotencyWindowMs: "9000" });
  assert.deepEqual(await getIdempotencyStats(), {
    activeKeys: invalid.length,
    windowMs: DEFAULT_IDEMPOTENCY_WINDOW_MS,
  });

  t.mock.timers.tick(DEFAULT_IDEMPOTENCY_WINDOW_MS);
  assert.deepEqual(await getIdempotencyStats(), {
    activeKeys: 0,
    windowMs: DEFAULT_IDEMPOTENCY_WINDOW_MS,
  });
});

test("fractional positive windows use a whole millisecond consistently", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  await updateSettings({ idempotencyWindowMs: 0.2 });
  const settings = await getSettings();
  saveIdempotency("fraction", response, 200, settings.idempotencyWindowMs);
  assert.deepEqual(await getIdempotencyStats(), { activeKeys: 1, windowMs: 1 });
  assert.ok(checkIdempotency("fraction"));
  t.mock.timers.tick(1);
  assert.equal(checkIdempotency("fraction"), null);
});

test("previously accepted long windows keep their duration", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  await updateSettings({ idempotencyWindowMs: 900_000 });
  const settings = await getSettings();
  saveIdempotency("long", response, 200, settings.idempotencyWindowMs);
  t.mock.timers.tick(899_999);
  assert.ok(checkIdempotency("long"));
  assert.deepEqual(await getIdempotencyStats(), { activeKeys: 1, windowMs: 900_000 });
  t.mock.timers.tick(1);
  assert.equal(checkIdempotency("long"), null);
});

test("unrepresentable expiry is bounded to a finite safe timestamp", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  const lastTimestamp = 8_640_000_000_000_000;
  const windowMs = resolveIdempotencyWindowMs(Number.MAX_VALUE);
  assert.ok(Number.isSafeInteger(windowMs));
  assert.ok(now + windowMs <= lastTimestamp);
  saveIdempotency("bounded", response, 200, Number.MAX_VALUE);

  t.mock.timers.setTime(lastTimestamp - 1);
  assert.ok(checkIdempotency("bounded"));
  t.mock.timers.tick(1);
  assert.equal(checkIdempotency("bounded"), null);
});

test("settings updates affect new entries without extending completed replay windows", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  await updateSettings({ idempotencyWindowMs: 1000 });
  saveIdempotency("before", response, 200, (await getSettings()).idempotencyWindowMs);
  t.mock.timers.tick(500);
  await updateSettings({ idempotencyWindowMs: 10_000 });
  saveIdempotency("after", response, 200, (await getSettings()).idempotencyWindowMs);

  t.mock.timers.tick(500);
  assert.equal(checkIdempotency("before"), null);
  assert.ok(checkIdempotency("after"));
  assert.deepEqual(await getIdempotencyStats(), { activeKeys: 1, windowMs: 10_000 });
});
