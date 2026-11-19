// Snapshot the legacy settings defaults (the object literal getSettings()
// starts from in src/lib/db/settings.ts, before stored key_value rows are
// applied) for the Rust legacy settings importer
// (rust/red-routerd/src/legacy_settings.rs). A stored row equal to its default
// changes nothing. The literal is evaluated with an empty environment; the
// keys it derives from environment variables are listed as env_dependent.
// Regenerate whenever the legacy defaults change.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { requestBodyLimitMbFromEnv } from "../../src/shared/constants/bodySize";
import { DEFAULT_RESPONSES_PREVIOUS_RESPONSE_ID_MODE } from "../../src/shared/constants/responsesPreviousResponseId";

const source = readFileSync("src/lib/db/settings.ts", "utf8").replace(/\r\n/g, "\n");
const opening = "  const settings: Record<string, unknown> = {\n";
const start = source.indexOf(opening);
const end = source.indexOf("\n  };\n", start);
if (start < 0 || end < 0) throw new Error("getSettings defaults literal not found");
const literal = source.slice(start + opening.length - 2, end + 4);

const envDependent: string[] = [];
const evaluate = new Function(
  "isTruthyEnvFlag",
  "process",
  "requestBodyLimitMbFromEnv",
  "DEFAULT_RESPONSES_PREVIOUS_RESPONSE_ID_MODE",
  `return (${literal});`
);
const defaults = evaluate(
  () => false,
  { env: {} },
  requestBodyLimitMbFromEnv,
  DEFAULT_RESPONSES_PREVIOUS_RESPONSE_ID_MODE
) as Record<string, unknown>;
// A key is env-dependent when its value (up to the next top-level key, which
// may span lines) reads process.env.
const entries = [...literal.matchAll(/^ {4}([A-Za-z0-9_]+):/gm)];
entries.forEach((match, index) => {
  const value = literal.slice(match.index, entries[index + 1]?.index ?? literal.length);
  if (/process\.env/.test(value.replace(/\/\/[^\n]*/g, ""))) envDependent.push(match[1]);
});

const sourceCommit = execFileSync(
  "git",
  ["log", "-1", "--format=%H", "--", "src/lib/db/settings.ts"],
  { encoding: "utf8" }
).trim();

const keys = Object.keys(defaults).sort();
const lines = keys.map((key) => `    ${JSON.stringify(key)}: ${JSON.stringify(defaults[key])}`);
writeFileSync(
  "rust/red-routerd/src/legacy_settings_defaults.json",
  `{\n  "source_commit": ${JSON.stringify(sourceCommit)},\n` +
    `  "env_dependent": ${JSON.stringify(envDependent.sort())},\n` +
    `  "defaults": {\n${lines.join(",\n")}\n  }\n}\n`
);
console.log(`${keys.length} defaults, ${envDependent.length} env-dependent`);
