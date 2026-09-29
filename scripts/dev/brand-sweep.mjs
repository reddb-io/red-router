#!/usr/bin/env node
/**
 * Replaces the inherited product name in USER-VISIBLE text.
 *
 *   node scripts/dev/brand-sweep.mjs <path...>            # dry run, prints a per-file summary
 *   node scripts/dev/brand-sweep.mjs --write <path...>    # applies it
 *   node scripts/dev/brand-sweep.mjs --residual <path...> # lists what is still there
 *
 * Only the standalone capitalised words OmniRoute / OmniProxy are touched, and only on lines that
 * are not code comments and do not carry a compatibility identifier (headers, ids, markers that
 * other tools read back). Compatibility identifiers and upstream attribution stay: see
 * COMPAT_LINE below and the allowlist in tests/redrouter/native/branding-sweep.test.ts.
 */
import fs from "node:fs";
import path from "node:path";

export const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".sh",
  ".example",
  ".svg",
  ".yaml",
  ".yml",
  ".html",
  ".txt",
  ".md",
  ".json",
]);
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  ".claude",
  "_tasks",
  "dist",
  "coverage",
]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

/** Lines carrying identifiers that other tools or stored data read back: never touched. */
export const COMPAT_LINE = [
  /\[OmniRoute (Caveman|Output)/, // prompt markers, written and read by compression
  /managed by OmniRoute/i, // markers we write into third-party config files and detect later
  /MITM (Root )?CA/, // certificate name in the OS trust store
  /OmniRoute Codex/, // connector name registered with ChatGPT
  /apiConfigs\.OmniRoute/,
  /section\.name === "OmniRoute"/,
  /custom:OmniRoute/,
  /"OmniRoute"\s*\)\s*$/, // guarded below by the word rules; kept for explicit review
  /radar\.omniroute/,
  /raw\.githubusercontent\.com\/diegosouzapw\/OmniRoute/, // upstream skills catalog
  /diegosouzapw\/OmniRoute\/(blob|tree)\/[^\s"']*\/skills\//,
  /diegosouzapw\/tOmni/,
  /productBranding/,
];

const WORD = /(?<![\w./@:$-])OmniRoute(?![\w-])/g;
const PROXY_WORD = /(?<![\w./@:$-])OmniProxy(?![\w-])/g;
const UPSTREAM_REPO = /github\.com\/diegosouzapw\/OmniRoute/g;
const CLI_COMMANDS =
  "setup|serve|start|stop|keys|mcp|config|auth|combo|combos|doctor|status|launch|run|login|logout|update|providers|provider|models|test|logs|tray|quota|plugin|redis|completion|connect|configure|import|export|backup|restore|reset|version|help|reset-password|oauth|health|list-combos|list-keys|switch-combo|set-budget";
const CLI_HINT = new RegExp(`(?<![\\w./@-])omniroute(?= (?:${CLI_COMMANDS}|--)\\b)`, "g");

const isCommentLine = (line) => /^\s*(\/\/|\/\*|\*|#)/.test(line);

export function sweepLine(line, ext) {
  if (SOURCE_EXTENSIONS.has(ext) && isCommentLine(line)) return line;
  if (COMPAT_LINE.some((rule) => rule.test(line))) return line;
  let next = line
    .replace(/\b(an|An) (?=OmniRoute)/g, (m, article) => `${article === "An" ? "A" : "a"} `)
    .replace(WORD, "RedRouter")
    .replace(PROXY_WORD, "Proxy")
    .replace(CLI_HINT, "red-router")
    .replace(/npx omniroute/g, "npx @reddb-io/red-router");
  if (!/\/(blob|tree)\/[^\s"']*\/skills\//.test(next)) {
    next = next.replace(UPSTREAM_REPO, "github.com/reddb-io/red-router");
  }
  return next;
}

export function sweepText(text, ext) {
  return text
    .split("\n")
    .map((line) => sweepLine(line, ext))
    .join("\n");
}

function* walk(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    yield target;
    return;
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    yield* walk(path.join(target, entry.name));
  }
}

/** Files whose readers match the old text in configs we wrote earlier: changed by hand instead. */
const MANUAL_FILES = [
  "src/shared/services/grokBuildConfig.ts",
  "src/shared/services/qwenCodeConfig.ts",
  "src/shared/constants/productBranding.ts",
];

const isTestFile = (file) =>
  /^tests\//.test(file) || /(^|\/)__tests__\//.test(file) || /\.test\.[tj]sx?$/.test(file);

/** Lines a sweep would still change, as `file:line: text`. Empty means the areas are clean. */
export function findLeftovers(roots) {
  const found = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const file of walk(root)) {
      const ext = path.extname(file);
      if (!TEXT_EXTENSIONS.has(ext) || isTestFile(file) || MANUAL_FILES.includes(file)) continue;
      const original = fs.readFileSync(file, "utf8");
      if (!/omniroute|omniproxy/i.test(original)) continue;
      original.split("\n").forEach((line, index) => {
        if (sweepLine(line, ext) !== line)
          found.push(`${file}:${index + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
  }
  return found;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const residual = args.includes("--residual");
  const roots = args.filter((arg) => !arg.startsWith("--"));
  let changedFiles = 0;
  let changedLines = 0;
  for (const root of roots) {
    for (const file of walk(root)) {
      const ext = path.extname(file);
      if (!TEXT_EXTENSIONS.has(ext) || isTestFile(file) || MANUAL_FILES.includes(file)) continue;
      const original = fs.readFileSync(file, "utf8");
      if (!/omniroute|omniproxy/i.test(original)) continue;
      const next = sweepText(original, ext);
      if (residual) {
        next.split("\n").forEach((line, index) => {
          if (
            /omniroute|omniproxy/i.test(line) &&
            !(SOURCE_EXTENSIONS.has(ext) && isCommentLine(line))
          )
            console.log(`${file}:${index + 1}: ${line.trim().slice(0, 160)}`);
        });
        continue;
      }
      if (next === original) continue;
      const lines = original
        .split("\n")
        .filter((line, index) => line !== next.split("\n")[index]).length;
      changedFiles++;
      changedLines += lines;
      if (write) fs.writeFileSync(file, next);
      else console.log(`${lines}\t${file}`);
    }
  }
  if (!residual)
    console.log(
      `${write ? "changed" : "would change"} ${changedLines} lines in ${changedFiles} files`
    );
}
