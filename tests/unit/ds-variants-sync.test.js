import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../scripts/sync-ds-variants.mjs", import.meta.url));

describe("design system variant contracts", () => {
  it("keeps src/shared/ds in sync with the vendored *.variants.ts", () => {
    const run = spawnSync(process.execPath, [script, "--check"], { encoding: "utf8" });
    expect(run.stderr.split("\n").filter((line) => line.startsWith("stale:"))).toEqual([]);
    expect(run.status).toBe(0);
  });
});
