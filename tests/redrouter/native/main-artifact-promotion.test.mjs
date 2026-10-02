import assert from "node:assert/strict";
import test from "node:test";
import { selectMainRun } from "../../../scripts/release/promote-main-artifact.mjs";

test("promotion requires the completed successful main push for the exact source", () => {
  const sha = "a".repeat(40);
  const valid = {
    id: 5,
    run_attempt: 2,
    head_sha: sha,
    head_branch: "main",
    event: "push",
    status: "completed",
    conclusion: "success",
  };
  const rejected = [
    { ...valid, head_sha: "b".repeat(40) },
    { ...valid, head_branch: "v0.57.4" },
    { ...valid, event: "pull_request" },
    { ...valid, status: "in_progress" },
    { ...valid, conclusion: "failure" },
  ];
  assert.equal(selectMainRun(rejected, sha), undefined);
  assert.equal(selectMainRun([...rejected, valid], sha), valid);
});
