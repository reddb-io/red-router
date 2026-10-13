import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import YAML from "yaml";

test("publication-only retries download the original successful artifact identity", () => {
  const workflow = YAML.parse(readFileSync(".github/workflows/red-publish.yml", "utf8"));
  const download = workflow.jobs.release.steps.find(
    (step: { name?: string }) => step.name === "Download the tested tarball"
  );
  const artifactStore = new Map([["redrouter-release-101-1", "exact-tested-tarball"]]);
  for (const retry of [1, 2, 3]) {
    const values: Record<string, string> = {
      "needs.build.outputs.artifact_run_id": "101",
      "needs.build.outputs.artifact_run_attempt": "1",
      "github.run_id": "202",
      "github.run_attempt": String(retry),
    };
    const expand = (text: string) =>
      text.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_all, key) => {
        assert.ok(Object.hasOwn(values, key));
        return values[key];
      });
    assert.equal(artifactStore.get(expand(download.with.name)), "exact-tested-tarball");
    assert.equal(expand(download.with["run-id"]), "101");
  }
  assert.equal(download.with["github-token"], "${{ github.token }}");
});
