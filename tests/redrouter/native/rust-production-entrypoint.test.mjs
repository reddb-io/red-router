import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const read = (path) => readFile(new URL(`../../../${path}`, import.meta.url), "utf8");

describe("Rust production entrypoint", () => {
  it("exposes explicit build and start commands for the Rust server and SPA", async () => {
    const pkg = JSON.parse(await read("package.json"));

    assert.match(pkg.scripts["build:rust"], /build:rust-dashboard/);
    assert.match(pkg.scripts["build:rust"], /build:rust-server/);
    assert.match(pkg.scripts["build:rust-server"], /rust\/red-routerd\/Cargo\.toml/);
    assert.match(pkg.scripts["start:rust"], /RED_ROUTER_SPA_DIR=.build\/rust-dashboard/);
    assert.match(pkg.scripts["start:rust"], /rust\/red-routerd\/Cargo\.toml/);
    assert.match(pkg.scripts["build:rust-package"], /stage-rust-runtime\.mjs/);
    assert.match(pkg.scripts["build:release"], /build:rust-dashboard/);
    assert.ok(pkg.files.includes("rust-runtime/"));
  });

  it("makes the loopback-bound Rust and SQLite service the compose default", async () => {
    const compose = await read("docker-compose.yml");
    const service = compose.match(/  redrouter-rust:\r?\n([\s\S]*?)(?=\r?\n  # ── Redis)/)?.[1];

    assert.ok(service);
    assert.match(service, /dockerfile: Dockerfile\.rust/);
    assert.match(service, /RED_ROUTER_DB_BACKEND=sqlite/);
    assert.match(service, /RED_ROUTER_SPA_DIR=\/app\/dashboard/);
    assert.ok(service.includes("${APP_BIND_HOST:-127.0.0.1}"));
    assert.doesNotMatch(service, /profiles:/);
    assert.doesNotMatch(service, /node|next/i);

    const redis = compose.match(/  redis:\r?\n([\s\S]*?)(?=\r?\n  # ── Profile: base)/)?.[1];
    assert.ok(redis);
    assert.match(redis, /profiles:\r?\n\s+- legacy/);
  });

  it("keeps Node and Next.js out of the Rust runtime image", async () => {
    const dockerfile = await read("Dockerfile.rust");
    const runtime = dockerfile.slice(dockerfile.lastIndexOf("FROM debian:"));

    assert.ok(runtime.includes('ENTRYPOINT ["red-routerd"]'));
    assert.ok(
      runtime.includes(
        "COPY --from=dashboard-builder --chown=redrouter:redrouter /src/.build/rust-dashboard/ /app/dashboard/"
      )
    );
    assert.doesNotMatch(runtime, /\b(?:node|npm|next)\b/i);
  });

  it("makes the packaged CLI prefer Rust while keeping an explicit rollback", async () => {
    const serve = await read("bin/cli/commands/serve.mjs");
    const resolver = await read("bin/cli/runtime/rustRuntime.mjs");

    assert.match(serve, /--runtime <runtime>/);
    assert.match(serve, /resolveRustRuntime/);
    assert.match(resolver, /selected === "next"/);
    assert.match(resolver, /if \(rust\) return rust/);
    assert.match(resolver, /rust-runtime.*dashboard/s);
  });
});
