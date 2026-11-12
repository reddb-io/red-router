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
  });

  it("defines a loopback-bound Rust and SQLite compose profile", async () => {
    const compose = await read("docker-compose.yml");
    const service = compose.match(/  redrouter-rust:\r?\n([\s\S]*?)(?=\r?\n  # ── Redis)/)?.[1];

    assert.ok(service);
    assert.match(service, /dockerfile: Dockerfile\.rust/);
    assert.match(service, /RED_ROUTER_DB_BACKEND=sqlite/);
    assert.match(service, /RED_ROUTER_SPA_DIR=\/app\/dashboard/);
    assert.ok(service.includes("${APP_BIND_HOST:-127.0.0.1}"));
    assert.match(service, /- rust/);
    assert.doesNotMatch(service, /node|next/i);
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
});
