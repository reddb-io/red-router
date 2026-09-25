#!/usr/bin/env node
// Generate the dashboard's JS copies of the design system's appearance contracts.
//
// vendor/ds is the design system as its Sync writes it from
// design-system.manifest.json (the design-system README's "Consuming it"). The
// dashboard is React and plain JavaScript, so it takes only the CSS and the
// appearance contracts (*.variants.ts) of the components it renders: this strips
// their TypeScript-only syntax with Node's stripTypeScriptTypes and writes
// src/shared/ds/*.variants.js. Never edit the generated files: bump the manifest,
// re-run the Sync, then `node scripts/sync-ds-variants.mjs`.
// `--check` exits non-zero when a generated file is stale.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const kitsDir = join(root, "vendor/ds/kits");
// The contracts the dashboard renders, by the path the Sync lays them out at.
export const USED_CONTRACTS = [
  "base/src/badge.variants.ts",
  "base/src/breadcrumbs.variants.ts",
  "base/src/button.variants.ts",
  "base/src/card.variants.ts",
  "base/src/input.variants.ts",
  "base/src/select.variants.ts",
  "app/src/composites/application-shell.variants.ts",
  "app/src/composites/page-heading.variants.ts",
  "app/src/primitives/nav-item.variants.ts",
];
const outDir = join(root, "src/shared/ds");
const check = process.argv.includes("--check");

mkdirSync(outDir, { recursive: true });
let stale = 0;
for (const rel of USED_CONTRACTS) {
  const file = rel.split("/").pop();
  {
    const source = readFileSync(join(kitsDir, rel), "utf8");
    const js = stripTypeScriptTypes(source, { mode: "strip" });
    const header = `// GENERATED from vendor/ds/kits/${rel} by scripts/sync-ds-variants.mjs — do not edit.\n`;
    const output = header + js;
    const target = join(outDir, file.replace(/\.ts$/, ".js"));
    if (check) {
      if (!existsSync(target) || readFileSync(target, "utf8") !== output) {
        console.error(`stale: ${target}`);
        stale++;
      }
      continue;
    }
    writeFileSync(target, output);
    console.log(`wrote ${target}`);
  }
}
if (stale) process.exit(1);
