import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const SUPPORTED_RUNTIME_MODES = new Set(["auto", "rust", "next"]);

function executableName(platform) {
  return platform === "win32" ? "red-routerd.exe" : "red-routerd";
}

function firstExisting(paths, exists = existsSync) {
  return paths.find((path) => path && exists(path)) ?? null;
}

/**
 * Locate the native Rust server and its static dashboard without importing any
 * backend code. Release packages put both under rust-runtime/; source checkouts
 * may use Cargo's release target and Vite's normal build directory instead.
 */
export function resolveRustRuntime({
  root,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  exists = existsSync,
} = {}) {
  if (!root) throw new Error("root is required to resolve the Rust runtime");

  const name = executableName(platform);
  const configuredBinary = env.RED_ROUTER_BINARY?.trim();
  const binaryPath = firstExisting(
    [
      configuredBinary ? resolve(configuredBinary) : null,
      join(root, "rust-runtime", `${platform}-${arch}`, name),
      join(root, "rust-runtime", "bin", name),
      join(root, "rust", "red-routerd", "target", "release", name),
    ],
    exists
  );

  const configuredSpa = env.RED_ROUTER_SPA_DIR?.trim();
  const spaDir = firstExisting(
    [
      configuredSpa ? resolve(configuredSpa) : null,
      join(root, "rust-runtime", "dashboard"),
      join(root, ".build", "rust-dashboard"),
    ],
    (path) => exists(path) && exists(join(path, "index.html"))
  );

  if (!binaryPath || !spaDir) return null;
  return { kind: "rust", binaryPath, spaDir };
}

export function resolveRuntimeMode(value = process.env.RED_ROUTER_RUNTIME) {
  const mode = String(value || "auto")
    .trim()
    .toLowerCase();
  if (!SUPPORTED_RUNTIME_MODES.has(mode)) {
    throw new Error("runtime must be one of: auto, rust, next");
  }
  return mode;
}

/**
 * Rust is the production default whenever the native artifact is available.
 * `next` remains an explicit rollback mode during the release transition.
 */
export function selectServerRuntime({ mode, rust, nextServerPath }) {
  const selected = resolveRuntimeMode(mode);
  if (selected === "next") return { kind: "next", serverPath: nextServerPath };
  if (rust) return rust;
  if (selected === "rust") {
    throw new Error(
      "Rust runtime is not installed (expected red-routerd and the static dashboard)"
    );
  }
  return { kind: "next", serverPath: nextServerPath };
}

export function buildRuntimeSpawn(runtime, memoryLimit, env = process.env, node = {}) {
  if (runtime.kind === "rust") {
    return {
      command: runtime.binaryPath,
      args: [],
      cwd: node.dataDir,
    };
  }
  return {
    command: process.versions.bun ? process.execPath : "node",
    args: [
      ...(process.versions.bun
        ? ["--preload", node.bunPreloadPath]
        : node.buildNodeHeapArgs(env, memoryLimit)),
      runtime.serverPath,
    ],
    cwd: node.appDir,
  };
}
