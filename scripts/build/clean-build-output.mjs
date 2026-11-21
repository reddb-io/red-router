#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Remove every generated Rust/SPA release output before a reproducible build. */
export async function cleanBuildOutput(rootDir = process.cwd()) {
  const outputs = [".build", "dist", "rust-runtime"];
  await Promise.all(
    outputs.map((output) => fs.rm(path.join(rootDir, output), { recursive: true, force: true }))
  );
  return { removed: outputs };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { removed } = await cleanBuildOutput();
  console.log(`[clean-build-output] Removed ${removed.join(", ")}`);
}
