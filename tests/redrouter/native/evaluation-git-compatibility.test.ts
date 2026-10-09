import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { simpleGit } from "simple-git";

test("patched evaluation git dependency preserves branch and comparison metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "redrouter-evaluation-git-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" }).trim();
  try {
    git("init", "--initial-branch=main");
    git("config", "user.name", "RedRouter CI");
    git("config", "user.email", "ci@reddb.io");
    await writeFile(join(directory, "fixture.txt"), "before\n");
    git("add", "fixture.txt");
    git("-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "-m", "baseline");
    const baseline = git("rev-parse", "HEAD");
    git("checkout", "-b", "comparison");
    await writeFile(join(directory, "fixture.txt"), "after\n");
    git("add", "fixture.txt");
    git(
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "comparison update"
    );
    const head = git("rev-parse", "HEAD");

    // These are the git operations used by promptfoo's code-scan metadata extraction.
    const repository = simpleGit(directory);
    const branches = await repository.branch();
    assert.equal(branches.current, "comparison");
    assert.ok(branches.all.includes("main"));
    assert.equal((await repository.revparse(["main"])).trim(), baseline);
    assert.equal((await repository.revparse(["HEAD"])).trim(), head);
    const history = await repository.log({ from: "main", to: "HEAD" });
    assert.equal(history.all.length, 1);
    assert.equal(history.latest?.hash, head);
    assert.equal(history.latest?.message, "comparison update");
    assert.equal(history.latest?.author_name, "RedRouter CI");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
