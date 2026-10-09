// Refresh source pins before Changesets versions a release. Never resolve
// "latest" during inference or artifact publication: CI tests the pinned source.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const SEMVER = /^\d+\.\d+\.\d+$/;

async function registryMetadata(name, version = "latest") {
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`,
    { signal: AbortSignal.timeout(20_000) }
  );
  if (!response.ok) throw new Error(`Cannot refresh ${name}: npm HTTP ${response.status}`);
  const metadata = await response.json();
  if (!SEMVER.test(metadata.version)) throw new Error(`Invalid stable version for ${name}`);
  return metadata;
}

/** Capture only identity fields from a real CLI talking to an isolated loopback server. */
export async function captureClaudeIdentity(binary, directory, expectedVersion) {
  let child;
  let timer;
  let settle;
  let fail;
  const captured = new Promise((accept, reject) => {
    settle = accept;
    fail = reject;
  });
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 1024 * 1024) throw new Error("Unexpected capture payload size");
        chunks.push(chunk);
      }
      response.writeHead(401, { "content-type": "application/json" });
      response.end(
        '{"type":"error","error":{"type":"authentication_error","message":"Local identity capture completed"}}'
      );
      if (!request.url?.startsWith("/v1/messages")) return;
      const billing = Buffer.concat(chunks)
        .toString()
        .match(/cc_version=(\d+\.\d+\.\d+)\.([a-z0-9]{3});/);
      const sdk = request.headers["x-stainless-package-version"];
      const runtime = request.headers["x-stainless-runtime-version"];
      if (
        billing?.[1] !== expectedVersion ||
        !SEMVER.test(sdk) ||
        !/^v\d+\.\d+\.\d+$/.test(runtime) ||
        !String(request.headers["user-agent"]).includes(`claude-cli/${expectedVersion} `)
      ) {
        throw new Error(
          "Claude CLI identity shape changed; review the captured protocol before updating"
        );
      }
      settle({ version: billing[1], revision: billing[2], sdk, runtime });
    } catch (error) {
      response.destroy();
      fail(error);
    }
  });
  try {
    await new Promise((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", accept);
    });
    child = spawn(
      binary,
      ["-p", "hello", "--model", "claude-sonnet-4-6", "--tools", "", "--max-turns", "1"],
      {
        cwd: directory,
        env: {
          PATH: process.env.PATH,
          HOME: directory,
          CLAUDE_CONFIG_DIR: directory,
          ANTHROPIC_API_KEY: "local-identity-capture-placeholder",
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
          DISABLE_TELEMETRY: "1",
          DISABLE_ERROR_REPORTING: "1",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        },
        stdio: "ignore",
      }
    );
    child.once("error", fail);
    child.once("exit", () => fail(new Error("Claude CLI exited before identity capture")));
    timer = setTimeout(() => fail(new Error("Claude identity capture timed out")), 30_000);
    return await captured;
  } finally {
    clearTimeout(timer);
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((accept) => child.once("exit", accept));
      child.kill("SIGKILL");
      await exited;
    }
    server.closeAllConnections();
    await new Promise((accept) => server.close(accept));
  }
}

export function replaceIdentityPin(source, name, value) {
  const pattern = new RegExp(`(export const ${name} = ")[^"]+(";)`);
  if (!pattern.test(source)) throw new Error(`Cannot find identity pin ${name}`);
  return source.replace(pattern, (_match, prefix, suffix) => `${prefix}${value}${suffix}`);
}

export async function refreshCliIdentities({ root = projectRoot } = {}) {
  const [codex, claude] = await Promise.all([
    registryMetadata("@openai/codex"),
    registryMetadata("@anthropic-ai/claude-code"),
  ]);
  const codexPath = join(root, "src/shared/constants/codexClient.ts");
  const claudePath = join(root, "src/shared/constants/claudeCodeClient.ts");
  const dockerPath = join(root, "Dockerfile");
  const [codexSource, claudeSource, dockerSource] = await Promise.all([
    readFile(codexPath, "utf8"),
    readFile(claudePath, "utf8"),
    readFile(dockerPath, "utf8"),
  ]);
  let nextClaude = claudeSource;
  if (!claudeSource.includes(`CLAUDE_CODE_CLIENT_VERSION = "${claude.version}"`)) {
    if (process.platform !== "linux" || process.arch !== "x64")
      throw new Error(
        "Refresh Claude identities on Linux x64 so the published native CLI can be captured"
      );
    const metadata = await registryMetadata("@anthropic-ai/claude-code-linux-x64", claude.version);
    const url = new URL(metadata.dist.tarball);
    if (url.protocol !== "https:" || url.hostname !== "registry.npmjs.org")
      throw new Error("Unexpected npm artifact host");
    const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok) throw new Error(`Claude artifact download failed: HTTP ${response.status}`);
    const artifact = Buffer.from(await response.arrayBuffer());
    const integrity = `sha512-${createHash("sha512").update(artifact).digest("base64")}`;
    if (integrity !== metadata.dist.integrity)
      throw new Error("Claude CLI artifact integrity mismatch");
    const stage = await mkdtemp(join(tmpdir(), "redrouter-cli-capture-"));
    try {
      const archive = join(stage, "cli.tgz");
      await writeFile(archive, artifact);
      await execFileAsync("tar", ["-xf", archive, "-C", stage, "package/claude"]);
      const identity = await captureClaudeIdentity(
        join(stage, "package/claude"),
        stage,
        claude.version
      );
      for (const [name, value] of Object.entries({
        CLAUDE_CODE_CLIENT_VERSION: identity.version,
        CLAUDE_CODE_CLIENT_BUILD_REVISION: identity.revision,
        CLAUDE_CODE_SDK_PACKAGE_VERSION: identity.sdk,
        CLAUDE_CODE_RUNTIME_VERSION: identity.runtime,
      }))
        nextClaude = replaceIdentityPin(nextClaude, name, value);
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
  const nextCodex = replaceIdentityPin(codexSource, "DEFAULT_CODEX_CLIENT_VERSION", codex.version);
  const nextDocker = dockerSource
    .replace(/@openai\/codex@\d+\.\d+\.\d+/, `@openai/codex@${codex.version}`)
    .replace(
      /@anthropic-ai\/claude-code@\d+\.\d+\.\d+/,
      `@anthropic-ai/claude-code@${claude.version}`
    );
  if (nextDocker === dockerSource && nextCodex === codexSource && nextClaude === claudeSource) {
    console.log(`CLI identities current: Codex ${codex.version}, Claude ${claude.version}`);
    return false;
  }
  // Do not clobber edits made while the native artifact was downloaded/captured.
  for (const [path, original] of [
    [codexPath, codexSource],
    [claudePath, claudeSource],
    [dockerPath, dockerSource],
  ])
    if ((await readFile(path, "utf8")) !== original)
      throw new Error(`File changed during identity refresh: ${path}`);
  await writeFile(codexPath, nextCodex);
  await writeFile(claudePath, nextClaude);
  await writeFile(dockerPath, nextDocker);
  await writeFile(
    join(root, ".changeset/cli-identities-refresh.md"),
    `---\n"@reddb-io/red-router": patch\n---\n\nRefresh Codex ${codex.version} and Claude Code ${claude.version} CLI identities and Docker pins.\n`
  );
  console.log(
    `Refreshed CLI identities: Codex ${codex.version}, Claude ${claude.version}. Validate and commit before tagging.`
  );
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await refreshCliIdentities();
}
