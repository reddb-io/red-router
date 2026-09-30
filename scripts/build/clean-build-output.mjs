#!/usr/bin/env node

/**
 * clean-build-output.mjs — the reset `npm run build:release` runs before it builds.
 *
 * By default this is exactly `rm -rf .build dist`. With RR_KEEP_NEXT_CACHE=1 it removes the same
 * things EXCEPT `.build/next/cache`, Next's own content-addressed build cache, so CI can restore it
 * between runs. Everything that decides what ships is still rebuilt from scratch: the standalone
 * output is reset by the build itself and `write-build-sha.mjs` refuses to run without a fresh one.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const NEXT_CACHE_RELATIVE = path.join("next", "cache");

export async function cleanBuildOutput(rootDir = process.cwd(), env = process.env) {
  const buildDir = path.join(rootDir, ".build");
  const distDir = path.join(rootDir, "dist");
  await fs.rm(distDir, { recursive: true, force: true });

  if (env.RR_KEEP_NEXT_CACHE !== "1") {
    await fs.rm(buildDir, { recursive: true, force: true });
    return { keptCache: false };
  }

  const keep = path.join(buildDir, NEXT_CACHE_RELATIVE);
  let hasCache = false;
  try {
    hasCache = (await fs.stat(keep)).isDirectory();
  } catch {
    hasCache = false;
  }
  if (!hasCache) {
    await fs.rm(buildDir, { recursive: true, force: true });
    return { keptCache: false };
  }

  // Move the cache aside, clear everything else, put it back.
  const parking = path.join(rootDir, `.build-cache-parking-${process.pid}`);
  await fs.rm(parking, { recursive: true, force: true });
  await fs.rename(keep, parking);
  await fs.rm(buildDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(keep), { recursive: true });
  await fs.rename(parking, keep);
  return { keptCache: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { keptCache } = await cleanBuildOutput();
  console.log(
    keptCache
      ? "[clean-build-output] Cleared .build and dist, kept .build/next/cache"
      : "[clean-build-output] Cleared .build and dist"
  );
}
