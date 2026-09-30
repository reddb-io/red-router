import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// Nothing is pre-approved: a fresh install must not have a network-facing or cloud feature on.
const dataDir = mkdtempSync(join(tmpdir(), "redrouter-opt-in-defaults-"));
mkdirSync(dataDir, { recursive: true });
process.env.DATA_DIR = dataDir;
const core = await import("../../../src/lib/db/core.ts");
const { getSettings } = await import("../../../src/lib/db/settings.ts");

after(() => {
  core.resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

test("a fresh install has every outward feature switched off", async () => {
  const settings = await getSettings();
  for (const key of [
    "cloudEnabled",
    "tailscaleEnabled",
    "oidcEnabled",
    "samlEnabled",
    "mcpEnabled",
    "a2aEnabled",
    "prometheusMetricsEnabled",
    "passwordBreachCheckEnabled",
  ]) {
    assert.equal(settings[key], false, `${key} must default to off`);
  }
  assert.deepEqual(settings.enabledNoAuthProviders, []);
});
