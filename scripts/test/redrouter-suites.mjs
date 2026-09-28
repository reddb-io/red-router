import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export function suiteFiles(kind, projectRoot = root) {
  if (!["native", "ui", "e2e"].includes(kind)) throw new Error(`Unknown RedRouter suite: ${kind}`);
  const manifest = JSON.parse(
    readFileSync(join(projectRoot, "config/testing/redrouter-suites.json"), "utf8")
  );
  if (!Array.isArray(manifest[kind])) throw new Error(`Missing RedRouter suite: ${kind}`);
  const files = new Set(manifest[kind]);
  // New product tests are automatically discovered; the manifest only retains
  // existing tests in legacy locations. Never silently fall back to all tests.
  const base = `tests/redrouter/${kind}`;
  if (existsSync(join(projectRoot, base))) {
    for (const file of readdirSync(join(projectRoot, base), { recursive: true })) {
      if (/\.(test|spec)\.(ts|tsx|mjs)$/.test(file))
        files.add(`${base}/${file.replaceAll("\\", "/")}`);
    }
  }
  for (const file of files) {
    if (
      typeof file !== "string" ||
      !file.startsWith("tests/") ||
      file.split("/").includes("..") ||
      !existsSync(join(projectRoot, file))
    ) {
      throw new Error(`Invalid or missing RedRouter test: ${file}`);
    }
  }
  if (!files.size) throw new Error(`RedRouter suite ${kind} is empty`);
  return [...files].sort();
}
