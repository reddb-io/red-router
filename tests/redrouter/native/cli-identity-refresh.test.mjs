import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  replaceIdentityPin,
  captureClaudeIdentity,
} from "../../../scripts/release/refresh-cli-identities.mjs";

test("identity capture uses isolated loopback credentials and reads the SDK/version pair emitted by a CLI", async () => {
  const directory = await mkdtemp(join(tmpdir(), "redrouter-capture-fixture-"));
  const binary = join(directory, "fixture.mjs");
  try {
    await writeFile(
      binary,
      `#!/usr/bin/env node
if (process.env.HOME !== process.env.CLAUDE_CONFIG_DIR || process.cwd() !== process.env.HOME) process.exit(1);
if (process.env.ANTHROPIC_API_KEY !== "local-identity-capture-placeholder") process.exit(2);
await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", {
method: "POST", headers: {"user-agent":"claude-cli/2.1.288 (external, sdk-cli)","x-stainless-package-version":"0.128.0","x-stainless-runtime-version":"v26.3.0"},
body: JSON.stringify({system:[{text:"x-anthropic-billing-header: cc_version=2.1.288.3f2; cc_entrypoint=sdk-cli;"}]})
});
`,
      { mode: 0o755 }
    );
    assert.deepEqual(await captureClaudeIdentity(binary, directory, "2.1.288"), {
      version: "2.1.288",
      revision: "3f2",
      sdk: "0.128.0",
      runtime: "v26.3.0",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI refresh changes only the selected pin and preserves literal version digits", () => {
  const source = 'export const VERSION = "1.0.0";\nexport const OTHER = "2.0.0";\n';
  assert.equal(
    replaceIdentityPin(source, "VERSION", "2.1.288"),
    'export const VERSION = "2.1.288";\nexport const OTHER = "2.0.0";\n'
  );
  assert.throws(() => replaceIdentityPin(source, "MISSING", "2.1.288"), /Cannot find/);
});

test("the Rust runtime image does not install provider CLIs", async () => {
  const [docker, codex, claude] = await Promise.all(
    [
      "Dockerfile",
      "src/shared/constants/codexClient.ts",
      "src/shared/constants/claudeCodeClient.ts",
    ].map((file) => readFile(file, "utf8"))
  );
  assert.match(codex, /DEFAULT_CODEX_CLIENT_VERSION = "\d+\.\d+\.\d+"/);
  assert.match(claude, /CLAUDE_CODE_CLIENT_VERSION = "\d+\.\d+\.\d+"/);
  assert.doesNotMatch(docker, /@openai\/codex|@anthropic-ai\/claude-code|npm install -g/);
  assert.match(docker, /ENTRYPOINT \["red-routerd"\]/);
});
