import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const BASELINE = "config/quality/material-icons-baseline.json";
const NEEDLE = "material-symbols-outlined";

interface Measure {
  occurrences: number;
  files: number;
}

/** Occurrences of the Material Symbols class in src/**\/*.{ts,tsx}, skipping *.test.* files. */
function measure(): Measure {
  let occurrences = 0;
  let files = 0;
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
        const count = fs.readFileSync(full, "utf8").split(NEEDLE).length - 1;
        if (count > 0) {
          occurrences += count;
          files += 1;
        }
      }
    }
  };
  walk(path.join(root, "src"));
  return { occurrences, files };
}

test("Material Symbols usage does not grow; new icons use the lucide Icon wrapper", () => {
  const baseline = JSON.parse(fs.readFileSync(path.join(root, BASELINE), "utf8")) as Measure;
  const now = measure();
  const hint =
    "Use `Icon` from src/shared/components/Icon.tsx (lucide glyphs, resolved through " +
    "src/shared/icons/navIcons.ts) instead of the `material-symbols-outlined` font.";

  assert.ok(
    now.occurrences <= baseline.occurrences,
    `material-symbols-outlined occurrences rose from ${baseline.occurrences} to ${now.occurrences}. ${hint}`
  );
  assert.ok(
    now.files <= baseline.files,
    `files using material-symbols-outlined rose from ${baseline.files} to ${now.files}. ${hint}`
  );

  if (now.occurrences < baseline.occurrences || now.files < baseline.files) {
    console.log(
      `Material icon usage went down (${baseline.occurrences} -> ${now.occurrences} occurrences, ` +
        `${baseline.files} -> ${now.files} files): lower the baseline in ${BASELINE}.`
    );
  }
});
