import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

export function normalizeTestPath(filename) {
  if (typeof filename !== "string" || filename.trim() === "") {
    throw new TypeError("Vitest result is missing a test file name");
  }
  const normalized = filename.replaceAll("\\", "/");
  const testsMarker = normalized.lastIndexOf("/tests/");
  if (testsMarker >= 0) return normalized.slice(testsMarker + 1);
  if (normalized.startsWith("tests/")) return normalized;
  return relative(repoRoot, filename).split(sep).join("/");
}

export function failedTestNames(results) {
  if (!Array.isArray(results?.testResults)) {
    throw new TypeError("Vitest results must contain a testResults array");
  }
  return results.testResults.flatMap((file) =>
    (file.assertionResults || [])
      .filter((assertion) => assertion.status === "failed")
      .map((assertion) => `${normalizeTestPath(file.name)} :: ${assertion.fullName}`)
  );
}
