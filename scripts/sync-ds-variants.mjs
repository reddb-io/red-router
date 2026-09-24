#!/usr/bin/env node
// Generate the dashboard's JS copies of the design system's appearance contracts.
//
// vendor/ds/kits/{base,app}/*.variants.ts are vendored byte-for-byte from the
// design-system release bundle (see vendor/ds/README.md). The dashboard is plain
// JavaScript, so this strips their TypeScript-only syntax with Node's built-in
// stripTypeScriptTypes and writes src/shared/ds/*.variants.js. Never edit the
// generated files: re-vendor the .ts and run `node scripts/sync-ds-variants.mjs`.
// `--check` exits non-zero when a generated file is stale.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const kitsDir = join(root, "vendor/ds/kits");
const kits = ["base", "app"];
const outDir = join(root, "src/shared/ds");
const check = process.argv.includes("--check");

mkdirSync(outDir, { recursive: true });
let stale = 0;
for (const kit of kits) {
  const srcDir = join(kitsDir, kit);
  for (const file of readdirSync(srcDir).filter((f) => f.endsWith(".variants.ts")).sort()) {
    const source = readFileSync(join(srcDir, file), "utf8");
    const js = stripTypeScriptTypes(source, { mode: "strip" });
    const header = `// GENERATED from vendor/ds/kits/${kit}/${file} by scripts/sync-ds-variants.mjs — do not edit.\n`;
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
