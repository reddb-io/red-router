import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * Ratchet for the providers dashboard: no raw Tailwind palette colours. Colour there is either
 * neutral (surface / border / text tokens) or a design-system feedback role reserved for real
 * state (success / warning / danger / info). A hue on a category, auth type or "Free" label is
 * what made the page read as a carnival, so labels share one neutral style (NeutralTag).
 */

const root = process.cwd();
const PROVIDERS_DIR = path.join(root, "src/app/(dashboard)/dashboard/providers");
const MODELS_DIR = path.join(root, "src/app/(dashboard)/dashboard/models");

const HUES =
  "red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone";
const PALETTE_CLASS = new RegExp(
  `(?<![\\w-])(?:[a-z-]+:)*(?:text|bg|border|ring|from|to|via|divide|fill|stroke|outline|decoration|accent|caret|shadow)-(?:${HUES})-\\d{2,3}(?:/\\d+)?(?![\\w-])`,
  "g"
);

/**
 * Files allowed to carry a raw palette class, with the reason. Empty on purpose: add an entry only
 * for a real exception (for example a terminal-style log view that must stay dark) and say why.
 */
const ALLOWLIST: Record<string, string> = {};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__" && entry.name !== "node_modules")
        out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function offences(dir: string): Array<{ file: string; line: number; match: string }> {
  const found: Array<{ file: string; line: number; match: string }> = [];
  for (const file of sourceFiles(dir)) {
    const rel = path.relative(root, file);
    if (ALLOWLIST[rel]) continue;
    fs.readFileSync(file, "utf8")
      .split("\n")
      .forEach((text, index) => {
        for (const match of text.match(PALETTE_CLASS) ?? []) {
          found.push({ file: rel, line: index + 1, match });
        }
      });
  }
  return found;
}

test("the providers dashboard uses no raw Tailwind palette colours", () => {
  const found = offences(PROVIDERS_DIR);
  assert.deepEqual(
    found,
    [],
    "Use neutral tokens (bg-surface, bg-muted, border-border, text-text-main, text-text-muted) " +
      "or a feedback role (text-feedback-success-foreground, ...) for real state only. " +
      "Labels use NeutralTag. Offences:\n" +
      found.map((f) => `${f.file}:${f.line} ${f.match}`).join("\n")
  );
});

test("the models catalogue page uses no raw Tailwind palette colours", () => {
  const found = offences(MODELS_DIR);
  assert.deepEqual(found, [], found.map((f) => `${f.file}:${f.line} ${f.match}`).join("\n"));
});

test("category, auth-type and Free labels share the one neutral tag style", () => {
  const tag = fs.readFileSync(path.join(PROVIDERS_DIR, "components/NeutralTag.tsx"), "utf8");
  assert.match(tag, /bg-muted/);
  assert.match(tag, /text-text-muted/);
  assert.deepEqual(tag.match(PALETTE_CLASS) ?? [], []);
});

test("allowlist entries always carry a reason", () => {
  for (const [file, reason] of Object.entries(ALLOWLIST)) {
    assert.ok(reason.trim().length > 10, `${file} needs a justification`);
    assert.ok(fs.existsSync(path.join(root, file)), `${file} no longer exists; drop the entry`);
  }
});
