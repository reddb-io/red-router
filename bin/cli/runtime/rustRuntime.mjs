import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const SUPPORTED_RUNTIME_MODES = new Set(["auto", "rust"]);

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
    throw new Error("runtime must be one of: auto, rust");
  }
  return mode;
}

/**
 * RedRouter has one backend runtime: the native Rust server. `auto` exists for
 * CLI compatibility, but it resolves to Rust and fails closed when the native
 * artifact is missing instead of reviving the retired Next.js backend.
 */
export function selectServerRuntime({ mode, rust }) {
  resolveRuntimeMode(mode);
  if (rust) return rust;
  throw new Error(
    "Rust runtime is not installed (expected red-routerd and the static dashboard)"
  );
}

export function buildRuntimeSpawn(runtime, _memoryLimit, _env = process.env, native = {}) {
  if (runtime.kind !== "rust") {
    throw new Error(`Unsupported server runtime: ${runtime.kind || "unknown"}`);
  }
  return {
    command: runtime.binaryPath,
    args: [],
    cwd: native.dataDir,
  };
}
