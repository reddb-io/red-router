#!/usr/bin/env node
/**
 * Rewrites hard-coded `/dashboard/<page>` navigation literals to the page's area URL
 * (`/dashboard/providers` -> `/proxy/providers`), using the table in
 * `src/shared/constants/dashboardUrls.ts`. Dry run by default; `--write` applies it.
 *
 *   node scripts/dev/links-codemod.mjs            # report only
 *   node scripts/dev/links-codemod.mjs --write    # rewrite the files
 *   node scripts/dev/links-codemod.mjs --json     # machine-readable report
 *
 * What it touches: a string or template literal that STARTS with `/dashboard/`. For a template only
 * the static prefix (up to the first `${`) is mapped. What it never touches, and reports instead:
 *   - `/dashboard` itself (the root) and pages the menu does not own (`/dashboard/onboarding`);
 *   - a line that COMPARES a path (`=== "/dashboard/..."`, `startsWith("/dashboard/...")`): the value
 *     compared is a `/dashboard` path (`canonicalDashboardPath(pathname)`), fix those by hand;
 *   - a template whose dynamic part could pick a page with its own URL (`/dashboard/settings/${tab}`);
 *   - the embedded-service proxy (`/embed`): Hard Rule #17 keeps its prefix;
 *   - comments, tests, API routes, the authz / route guard / proxy files, the URL table itself.
 *
 * `findLiterals` / `isSkippedFile` are shared with tests/redrouter/native/internal-links.test.ts, so
 * the ratchet scans exactly what the codemod scans. Run it from the repository root. It imports a
 * `.ts` module, so it needs a Node with type stripping (22.18+, 24+).
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const urls = await import(
  pathToFileURL(path.join(root, "src/shared/constants/dashboardUrls.ts")).href
);

export const SCAN_ROOTS = ["src", "bin/cli"];
const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

/** Files that must keep their `/dashboard` prefixes, with the reason. */
export const SKIPPED_FILES = [
  [/(^|\/)(tests?|__tests__)\//, "tests"],
  [/\.(test|spec)\.[cm]?[jt]sx?$/, "tests"],
  [/^src\/app\/api\//, "API routes"],
  [/^src\/server\/authz\//, "authz: keyed on the /dashboard prefix"],
  [/^src\/proxy\.ts$/, "proxy matcher: keyed on the /dashboard prefix"],
  [/routeGuard/, "route guard: keyed on the /dashboard prefix"],
  [/^src\/shared\/utils\/apiAuth\.ts$/, "auth: public-page check on the /dashboard path"],
  [
    /^src\/shared\/constants\/(dashboardUrls|dashboardUrlHistory|sidebarNav)\.ts$/,
    "the URL table and the menu model it is derived from",
  ],
  [
    /^src\/lib\/services\/(reverseProxy|htmlRewriter)\.ts$/,
    "embedded-service proxy (Hard Rule #17)",
  ],
  [/(^|\/)embed\//, "embedded-service proxy route (Hard Rule #17)"],
];

export function isSkippedFile(relativePath) {
  const normalized = relativePath.split(path.sep).join("/");
  return SKIPPED_FILES.find(([pattern]) => pattern.test(normalized))?.[1] ?? null;
}

const COMPARISON = [
  /(===|!==|==|!=)\s*$/, // text before the literal ends with an operator
  /\.(startsWith|endsWith|includes|indexOf|match|test|localeCompare)\(\s*$/,
  /\bcase\s+$/,
];
const COMPARISON_AFTER = [/^\s*(===|!==|==|!=)/, /^\s*\)?\s*\.(startsWith|endsWith)\b/];

const isComment = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);

/** Where the literal that opens at `start` (the quote) ends, and where its static prefix ends. */
function literalExtent(source, start) {
  const quote = source[start];
  let dynamicAt = -1;
  let index = start + 1;
  for (; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === quote) break;
    if (quote === "`" && char === "$" && source[index + 1] === "{" && dynamicAt === -1) {
      dynamicAt = index;
    }
    if (quote !== "`" && char === "\n") break;
  }
  return {
    staticEnd: dynamicAt === -1 ? index : dynamicAt,
    literalEnd: index,
    dynamic: dynamicAt !== -1,
  };
}

/** The rules whose page sits strictly below `prefix` (which ends with `/`). */
function hasDeeperRule(prefix) {
  return urls.dashboardUrlRules().some((rule) => rule.oldPrefix.startsWith(prefix));
}

/**
 * @typedef {object} DashboardLiteral
 * @property {number} start offset of the static prefix in the source
 * @property {number} end offset just after the static prefix
 * @property {number} line 1-based line number
 * @property {string} text the static prefix, as written
 * @property {boolean} dynamic true for a template literal with a `${...}` after the prefix
 * @property {"replace" | "keep"} action
 * @property {string} [reason] why a `keep` is kept
 * @property {string} [to] the area URL prefix that replaces `text` on a `replace`
 */

/**
 * The /dashboard literals of a source file, each with the decision the codemod takes.
 * `action`: `replace` | `keep`. `reason` explains every `keep`.
 * @param {string} source
 * @returns {DashboardLiteral[]}
 */
export function findLiterals(source) {
  /** @type {DashboardLiteral[]} */
  const found = [];
  const opening = /(["'`])\/dashboard(?![A-Za-z0-9_-])/g;
  let match;
  while ((match = opening.exec(source)) !== null) {
    const start = match.index;
    const lineStart = source.lastIndexOf("\n", start) + 1;
    const lineEnd = source.indexOf("\n", start);
    const line = source.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
    const lineNumber = source.slice(0, start).split("\n").length;
    const { staticEnd, literalEnd, dynamic } = literalExtent(source, start);
    const text = source.slice(start + 1, staticEnd);
    const whole = source.slice(start + 1, literalEnd);
    const entry = { start: start + 1, end: staticEnd, line: lineNumber, text, dynamic };

    if (isComment(line)) {
      found.push({ ...entry, action: "keep", reason: "comment" });
      continue;
    }
    if (text === "/dashboard" || /^\/dashboard[?#]/.test(text)) {
      found.push({ ...entry, action: "keep", reason: "the /dashboard root" });
      continue;
    }
    const before = source.slice(lineStart, start);
    const after = source.slice(staticEnd, lineEnd === -1 ? undefined : lineEnd);
    if (/\b(areaUrl|canonicalDashboardPath)\(\s*$/.test(before)) {
      found.push({ ...entry, action: "keep", reason: "already goes through areaUrl()" });
      continue;
    }
    if (COMPARISON.some((p) => p.test(before)) || COMPARISON_AFTER.some((p) => p.test(after))) {
      found.push({ ...entry, action: "keep", reason: "compares a pathname" });
      continue;
    }
    if (/\/embed(?![A-Za-z0-9_-])/.test(whole)) {
      found.push({ ...entry, action: "keep", reason: "embedded-service proxy (Hard Rule #17)" });
      continue;
    }

    let mapped;
    if (dynamic) {
      const tail = text[text.length - 1];
      if (text === "/dashboard/") {
        found.push({ ...entry, action: "keep", reason: "dynamic page name" });
        continue;
      }
      if (tail === "/") {
        if (hasDeeperRule(text)) {
          found.push({ ...entry, action: "keep", reason: "dynamic: a page below has its own URL" });
          continue;
        }
        mapped = `${urls.areaUrl(text.slice(0, -1))}/`;
      } else if (/[?#&=]/.test(text)) {
        mapped = urls.areaUrl(text);
      } else {
        found.push({ ...entry, action: "keep", reason: "dynamic: partial segment" });
        continue;
      }
    } else {
      mapped = text.endsWith("/") ? `${urls.areaUrl(text.slice(0, -1))}/` : urls.areaUrl(text);
    }
    if (mapped === text) {
      found.push({ ...entry, action: "keep", reason: "page the menu does not own" });
      continue;
    }
    found.push({ ...entry, action: "replace", to: mapped });
  }
  return found;
}

export function applyLiterals(source, literals) {
  let out = source;
  for (const literal of [...literals].filter((l) => l.action === "replace").reverse()) {
    out = out.slice(0, literal.start) + literal.to + out.slice(literal.end);
  }
  return out;
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (EXTENSIONS.has(path.extname(name))) yield full;
  }
}

export function scan(rootDir = root) {
  const files = [];
  for (const scanRoot of SCAN_ROOTS) {
    for (const full of walk(path.join(rootDir, scanRoot))) {
      const relative = path.relative(rootDir, full).split(path.sep).join("/");
      const skipped = isSkippedFile(relative);
      const source = readFileSync(full, "utf8");
      if (!source.includes("/dashboard")) continue;
      files.push({ file: relative, skipped, source, literals: findLiterals(source) });
    }
  }
  return files.sort((a, b) => a.file.localeCompare(b.file));
}

function main() {
  const args = new Set(process.argv.slice(2));
  const write = args.has("--write");
  const files = scan();
  let replaced = 0;
  let kept = 0;
  const leftovers = [];
  const changedFiles = [];
  for (const { file, skipped, source, literals } of files) {
    if (skipped) continue;
    const replacements = literals.filter((l) => l.action === "replace");
    for (const literal of literals) {
      if (literal.action === "keep" && literal.reason !== "comment") {
        kept += 1;
        leftovers.push({ file, line: literal.line, text: literal.text, reason: literal.reason });
      }
    }
    if (replacements.length === 0) continue;
    replaced += replacements.length;
    changedFiles.push({ file, count: replacements.length });
    if (write) writeFileSync(path.join(root, file), applyLiterals(source, literals));
  }
  const skippedFiles = files
    .filter((f) => f.skipped)
    .map((f) => ({ file: f.file, reason: f.skipped }));

  if (args.has("--json")) {
    console.log(
      JSON.stringify({ write, replaced, kept, changedFiles, leftovers, skippedFiles }, null, 2)
    );
    return;
  }
  console.log(
    `${write ? "Rewrote" : "Would rewrite"} ${replaced} literal(s) in ${changedFiles.length} file(s).`
  );
  for (const { file, count } of changedFiles)
    console.log(`  ${String(count).padStart(3)}  ${file}`);
  console.log(`\nLeft alone (${kept}):`);
  for (const { file, line, text, reason } of leftovers) {
    console.log(`  ${file}:${line}  ${text}  [${reason}]`);
  }
  console.log(`\nSkipped files (${skippedFiles.length}):`);
  for (const { file, reason } of skippedFiles) console.log(`  ${file}  [${reason}]`);
  if (!write) console.log("\nDry run. Re-run with --write to apply.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
