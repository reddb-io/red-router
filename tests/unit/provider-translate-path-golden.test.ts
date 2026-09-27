import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildProviderTranslatePathSnapshot,
  providerIds,
} from "../helpers/providerTranslatePathSnapshot.ts";
import { goldenSnapshot } from "../helpers/goldenSnapshot.ts";

test("GOLDEN provider.ts translate-path is stable across all providers", () => {
  const snapshot = buildProviderTranslatePathSnapshot();
  // Sanity: the snapshot must cover every registered provider.
  assert.equal(Object.keys(snapshot).length, providerIds.length);
  assert.ok(providerIds.length > 0, "expected at least one provider");
  goldenSnapshot("provider/translate-path", snapshot);
});

test("GOLDEN provider.ts translate-path snapshot is deterministic", () => {
  // The sanitizer must remove all run-to-run variance (github UUID, kimi device-id).
  const a = JSON.stringify(buildProviderTranslatePathSnapshot());
  const b = JSON.stringify(buildProviderTranslatePathSnapshot());
  assert.equal(a, b, "translate-path snapshot must be deterministic after sanitize");
});

test("GOLDEN guard catches translate-path drift", () => {
  // Prove the golden lock is a real regression guard: a mutated entry must be
  // detected by goldenSnapshot via the committed golden file. Uses an isolated
  // tmp dir so the real golden is never touched.
  const snapshot = buildProviderTranslatePathSnapshot();
  const firstId = providerIds[0];

  // Write a baseline golden into a tmp dir, then assert a mutated copy diverges.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-golden-"));
  try {
    process.env.UPDATE_GOLDEN = "1";
    goldenSnapshot("provider/translate-path", snapshot, tmpDir);
    delete process.env.UPDATE_GOLDEN;

    // Same value → passes.
    assert.doesNotThrow(() => goldenSnapshot("provider/translate-path", snapshot, tmpDir));

    // Mutated value → must throw (drift detected).
    const mutated = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
    mutated[firstId].format = "DRIFTED-FORMAT";
    assert.throws(() => goldenSnapshot("provider/translate-path", mutated, tmpDir));
  } finally {
    delete process.env.UPDATE_GOLDEN;
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
