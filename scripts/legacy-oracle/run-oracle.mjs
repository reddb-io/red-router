#!/usr/bin/env node
// Regenerate the differential oracle files of rust/red-routerd by running the
// legacy TypeScript under Node. Usage:
//
//   node scripts/legacy-oracle/run-oracle.mjs --list
//   node scripts/legacy-oracle/run-oracle.mjs <name> [--root <checkout>] [--out <file>]
//   node scripts/legacy-oracle/run-oracle.mjs --all [--root <checkout>]
//
// `--root` is a checkout holding the legacy TypeScript (default: this repo).
// See README.md for the one-time setup of legacy-deps/ and for what an oracle is.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const src = "rust/red-routerd/src";

const FULL = ["ref-hooks", "ref-hooks-pkg", "ref-hooks-heavy", "ref-hooks-deps", "ref-hooks-json", "ref-hooks-ts"];

// name -> { script, arg, hooks, out }. `arg` is how the script wants the
// legacy checkout: root-url, root-path, module-url:<rel>, source:<rel> or
// copy-url:<rel> (a type-stripped copy of a module, made by make-copy.mjs).
const ORACLES = {
  "opencode-go-formats": { script: "oc-formats", arg: "module-url:open-sse/config/providers/registry/opencode/go/index.ts", hooks: FULL, out: `${src}/opencode_go_formats.json` },
  "responses-helpers": { script: "resp-helpers-oracle", arg: "module-url:open-sse/translator/request/openai-responses/helpers.ts", hooks: FULL, out: `${src}/responses_helpers_oracle.json` },
  "responses-text": { script: "resp-text-oracle", arg: "source:open-sse/translator/request/openai-responses/toResponses.ts", hooks: [], out: `${src}/responses_text_oracle.json` },
  "reasoning-fields": { script: "readable-oracle", arg: "module-url:open-sse/utils/reasoningFields.ts", hooks: FULL, out: `${src}/reasoning_fields_oracle.json` },
  "responses-request": { script: "resp-request-oracle", arg: "copy-url:open-sse/translator/request/openai-responses/toResponses.ts", hooks: ["ref-hooks", "ref-hooks-stub"], out: `${src}/responses_request_oracle.json` },
  "responses-stream-support": { script: "stream-support-oracle", arg: "root-url", hooks: FULL, out: `${src}/responses_stream_support_oracle.json` },
  "responses-tool-identity": { script: "tool-identity-oracle", arg: "root-url", hooks: FULL, out: `${src}/responses_tool_identity_oracle.json` },
  "responses-stream-pure": { script: "stream-pure-oracle", arg: "root-url", hooks: FULL, out: `${src}/responses_stream_pure_oracle.json` },
  "reasoning-replayable": { script: "replayable-oracle", arg: "source:open-sse/services/reasoningInputPolicy.ts", hooks: [], out: `${src}/reasoning_replayable_oracle.json` },
  "stream-terminal": { script: "terminal-oracle", arg: "root-url", hooks: FULL, out: `${src}/stream_terminal_oracle.json` },
  "responses-stream-state": { script: "stream-state-oracle", arg: "root-url", hooks: FULL, out: `${src}/responses_stream_state_oracle.json` },
  "stream-error-format": { script: "stream-error-oracle", arg: "root-url", hooks: FULL, out: `${src}/stream_error_format_oracle.json` },
  "responses-stream": { script: "stream-oracle", arg: "root-path", hooks: FULL, out: `${src}/responses_stream_oracle.json` },
  "provider-error-rules": { script: "provider-rules-oracle", arg: "root-url", hooks: FULL, out: `${src}/provider_error_rules_oracle.json` },
  "quota-reset-parsing": { script: "quota-parse-oracle", arg: "root-url", hooks: FULL, out: `${src}/quota_reset_parsing_oracle.json` },
  "quota-text-cooldowns": { script: "quota-text-oracle", arg: "root-url", hooks: FULL, out: `${src}/quota_text_cooldowns_oracle.json` },
  "error-config": { script: "error-config-oracle", arg: "root-url", hooks: FULL, out: `${src}/error_config_oracle.json` },
  "error-text-classification": { script: "error-text-oracle", arg: "root-url", hooks: FULL, out: `${src}/error_text_classification_oracle.json` },
  "fallback-cooldown": { script: "af-cooldown", arg: "root-url", hooks: FULL, out: `${src}/fallback_cooldown_oracle.json` },
  // The matrix is large; only a subset is committed (see provider-failure).
  "failure-matrix": { script: "af-matrix", arg: "root-url", hooks: FULL, out: join(here, ".cache", "af-matrix.json"), internal: true },
};

function parseArguments(argv) {
  const options = { root: repo, names: [], all: false, list: false, out: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--root") options.root = resolve(argv[++index]);
    else if (value === "--out") options.out = resolve(argv[++index]);
    else if (value === "--all") options.all = true;
    else if (value === "--list") options.list = true;
    else options.names.push(value);
  }
  return options;
}

function legacyArgument(spec, root, name) {
  const [kind, relative] = spec.arg.split(":");
  if (kind === "root-url") return pathToFileURL(root).href.replace(/\/$/, "");
  if (kind === "root-path") return root;
  if (kind === "module-url") return pathToFileURL(join(root, relative)).href;
  if (kind === "source") return join(root, relative);
  if (kind === "copy-url") {
    const copy = join(here, ".cache", `${name}-copy.ts`);
    mkdirSync(dirname(copy), { recursive: true });
    const made = spawnSync(process.execPath, [join(here, "make-copy.mjs"), join(root, relative), copy], { stdio: "inherit" });
    if (made.status !== 0) throw new Error("make-copy failed");
    return pathToFileURL(copy).href;
  }
  throw new Error(`unknown argument kind ${kind}`);
}

function run(name, root, outOverride) {
  const spec = ORACLES[name];
  if (!spec) throw new Error(`unknown oracle ${name}; try --list`);
  const out = outOverride ?? (spec.out.startsWith("/") || /^[A-Za-z]:/.test(spec.out) ? spec.out : join(repo, spec.out));
  mkdirSync(dirname(out), { recursive: true });
  const dataDir = join(here, ".cache", "legacy-data");
  mkdirSync(dataDir, { recursive: true });
  const flags = spec.hooks.flatMap((hook) => ["--import", pathToFileURL(join(here, "hooks", `${hook}.mjs`)).href]);
  const script = join(here, "oracles", `${spec.script}.mjs`);
  const result = spawnSync(process.execPath, [...flags, script, legacyArgument(spec, root, name), out], {
    cwd: here,
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      LEGACY_ROOT: `${pathToFileURL(root).href.replace(/\/$/, "")}/`,
      // The legacy db layer opens a real SQLite store; never let it reach an installed app's.
      DATA_DIR: dataDir,
      RED_ROUTER_DATA_DIR: dataDir,
      TZ: "UTC",
      NODE_NO_WARNINGS: "1",
    },
  });
  if (result.status !== 0) throw new Error(`${name} failed (exit ${result.status})`);
  return out;
}

// The committed provider failure oracle is a subset of the failure matrix:
// status, body, provider and the ban, credit and resource-not-found decisions.
function providerFailureSubset(root) {
  const matrix = run("failure-matrix", root);
  const rows = JSON.parse(readFileSync(matrix, "utf8"));
  const statuses = [400, 401, 403, 404, 408, 410, 413, 422, 429, 500, 502, 503];
  const texts = ["account has been deactivated", "Your account has been suspended due to an unpaid invoice", "You exceeded your current quota", "insufficient credits", "Your credit balance is too low", "daily limit reached", "rate limit exceeded", "invalid request", "Conversation not found", "internal server error"];
  const providers = [null, "openai", "anthropic", "mistral", "codex", "claude", "github"];
  const subset = rows
    .filter((row) => statuses.includes(row.status) && texts.includes(row.text) && providers.includes(row.provider))
    .map((row) => [row.status, row.text, row.provider, row.out.creditsExhausted === true ? 1 : 0, row.out.permanent === true && row.out.reason === "auth_error" ? 1 : 0, row.out.shouldFallback === false && row.out.reason === "request_resource_not_found" ? 1 : 0]);
  const out = join(repo, `${src}/provider_failure_oracle.json`);
  writeFileSync(out, JSON.stringify(subset));
  console.log(`provider-failure: ${subset.length} rows`);
}

const options = parseArguments(process.argv.slice(2));
if (options.list) {
  for (const [name, spec] of Object.entries(ORACLES)) console.log(`${name.padEnd(28)} ${spec.internal ? "(intermediate)" : spec.out}`);
  console.log(`${"provider-failure".padEnd(28)} ${src}/provider_failure_oracle.json`);
  process.exit(0);
}
if (!existsSync(join(here, "legacy-deps", "node_modules"))) {
  console.error("legacy-deps/ is missing: see scripts/legacy-oracle/README.md for the one-time setup.");
  process.exit(1);
}
const names = options.all ? [...Object.keys(ORACLES).filter((name) => !ORACLES[name].internal), "provider-failure"] : options.names;
if (names.length === 0) {
  console.error("name an oracle, or use --list or --all");
  process.exit(1);
}
for (const name of names) {
  console.log(`== ${name}`);
  if (name === "provider-failure") providerFailureSubset(options.root);
  else console.log(`   -> ${run(name, options.root, names.length === 1 ? options.out : null)}`);
}
