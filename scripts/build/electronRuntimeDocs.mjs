import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

// Only canonical English docs ship with the desktop runtime. Authoring-only
// directories are removed from the temporary bundle.
export const ELECTRON_RUNTIME_DOC_PRUNE_RULES = Object.freeze({
  authoringDirectories: Object.freeze(["docs/research", "docs/superpowers"]),
});

function payloadSize(targetPath) {
  const stat = lstatSync(targetPath);
  if (!stat.isDirectory()) {
    return { files: 1, bytes: stat.size };
  }

  return readdirSync(targetPath).reduce(
    (total, entry) => {
      const payload = payloadSize(join(targetPath, entry));
      total.files += payload.files;
      total.bytes += payload.bytes;
      return total;
    },
    { files: 0, bytes: 0 }
  );
}

function removePayload(bundleRoot, relativePath, summary) {
  const root = resolve(bundleRoot);
  const targetPath = resolve(root, relativePath);
  if (targetPath !== root && !targetPath.startsWith(`${root}${sep}`)) {
    throw new Error(`[electron-docs] refusing to prune outside bundle root: ${relativePath}`);
  }
  if (!existsSync(targetPath)) return;

  const payload = payloadSize(targetPath);
  rmSync(targetPath, { recursive: true, force: true });
  summary.removedFiles += payload.files;
  summary.removedBytes += payload.bytes;
  summary.removedPaths.push(relative(root, targetPath).split(sep).join("/"));
}

/**
 * Remove docs that are useful while authoring OmniRoute but are never read by
 * the packaged desktop runtime. Canonical docs remain untouched; bundleRoot is
 * the disposable Electron staging directory.
 */
export function pruneElectronRuntimeDocs(bundleRoot) {
  const summary = { removedFiles: 0, removedBytes: 0, removedPaths: [] };
  for (const relativePath of ELECTRON_RUNTIME_DOC_PRUNE_RULES.authoringDirectories) {
    removePayload(bundleRoot, relativePath, summary);
  }

  summary.removedPaths.sort();
  return summary;
}
