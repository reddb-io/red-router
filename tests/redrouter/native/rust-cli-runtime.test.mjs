import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import {
  buildRuntimeSpawn,
  resolveRuntimeMode,
  resolveRustRuntime,
  selectServerRuntime,
} from "../../../bin/cli/runtime/rustRuntime.mjs";

describe("Rust CLI runtime", () => {
  it("prefers the platform Rust binary and packaged SPA", () => {
    const root = resolve("fixture-package");
    const binary = join(root, "rust-runtime", "win32-x64", "red-routerd.exe");
    const spa = join(root, "rust-runtime", "dashboard");
    const existing = new Set([binary, spa, join(spa, "index.html")]);

    assert.deepEqual(
      resolveRustRuntime({
        root,
        env: {},
        platform: "win32",
        arch: "x64",
        exists: (path) => existing.has(path),
      }),
      { kind: "rust", binaryPath: binary, spaDir: spa }
    );
  });

  it("uses Rust for every supported mode and never falls back to Next", () => {
    const rust = { kind: "rust", binaryPath: "/bin/red-routerd", spaDir: "/dashboard" };
    assert.equal(selectServerRuntime({ mode: "auto", rust }).kind, "rust");
    assert.equal(selectServerRuntime({ mode: "rust", rust }).kind, "rust");
    assert.throws(() => selectServerRuntime({ mode: "next", rust }), /auto, rust/);
    assert.throws(
      () => selectServerRuntime({ mode: "auto", rust: null }),
      /Rust runtime is not installed/
    );
    assert.throws(
      () => selectServerRuntime({ mode: "rust", rust: null }),
      /Rust runtime is not installed/
    );
  });

  it("rejects unknown runtime modes", () => {
    assert.equal(resolveRuntimeMode(), "auto");
    assert.throws(() => resolveRuntimeMode("python"), /auto, rust/);
  });

  it("executes red-routerd directly without a Node heap", () => {
    const launch = buildRuntimeSpawn(
      { kind: "rust", binaryPath: "/bin/red-routerd", spaDir: "/dashboard" },
      4096,
      {},
      { dataDir: "/data" }
    );
    assert.deepEqual(launch, {
      command: "/bin/red-routerd",
      args: [],
      cwd: "/data",
    });
    assert.throws(
      () => buildRuntimeSpawn({ kind: "next", serverPath: "/dist/server.js" }, 4096),
      /Unsupported server runtime/
    );
  });
});
