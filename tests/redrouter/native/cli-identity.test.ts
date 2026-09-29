import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

test("the startup banner spells RedRouter, not the inherited name", () => {
  const serve = read("bin/cli/commands/serve.mjs");
  assert.ok(!serve.includes("/ __ \\\\"), "the inherited ASCII-art banner is gone");
  assert.ok(serve.includes("|  _ \\\\ ___  __| |"), "the RedRouter banner is there");
});

test("shell completions are registered for the red-router binary and read its own data directory", () => {
  const completion = read("bin/cli/commands/completion.mjs");
  assert.doesNotMatch(completion, /omniroute/, "no lowercase inherited command or path names");
  assert.match(completion, /#compdef red-router/);
  assert.match(completion, /complete -F _red_router red-router/);
  assert.match(completion, /complete -c red-router/);
  assert.ok(completion.includes("${cachePath()}"), "the cache path is the resolved data directory");
});

test("hints the CLI prints name the command people actually run", () => {
  for (const file of [
    "bin/cli/commands/env.mjs",
    "bin/cli/commands/connect.mjs",
    "bin/cli/sqlite.mjs",
    "src/mitm/targets/kiro.ts",
  ]) {
    assert.doesNotMatch(read(file), /(?<![\w./@-])omniroute (?=[a-z<[-])/, file);
  }
});
