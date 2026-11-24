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
    assert.equal(pkg.scripts.build, "npm run build:rust");
    assert.equal(pkg.scripts.start, "npm run start:rust");
    assert.match(pkg.scripts.dev, /start:rust/);
    assert.match(pkg.scripts["build:release"], /build:rust-package/);
    assert.doesNotMatch(
      [pkg.scripts.build, pkg.scripts.start, pkg.scripts.dev, pkg.scripts["build:release"]].join(
        "\n"
      ),
      /next|run-next/i
    );
    assert.equal(pkg.dependencies.next, undefined);
    assert.equal(pkg.scripts.postbuild, undefined);
    assert.ok(pkg.files.includes("rust-runtime/"));
    assert.ok(!pkg.files.includes("dist/"));
  });

  it("makes the loopback-bound Rust and SQLite service the compose default", async () => {
    const compose = await read("docker-compose.yml");
    const service = compose.match(/  redrouter-rust:\r?\n([\s\S]*?)(?=\r?\nvolumes:)/)?.[1];

    assert.ok(service);
    assert.match(service, /dockerfile: Dockerfile\.rust/);
    assert.match(service, /RED_ROUTER_DB_BACKEND=sqlite/);
    assert.match(service, /RED_ROUTER_SPA_DIR=\/app\/dashboard/);
    assert.ok(service.includes("${APP_BIND_HOST:-127.0.0.1}"));
    assert.doesNotMatch(service, /profiles:/);
    assert.doesNotMatch(service, /node|next/i);

    const productionCompose = await read("docker-compose.prod.yml");
    assert.match(productionCompose, /dockerfile: Dockerfile\.rust/);
    assert.match(productionCompose, /RED_ROUTER_DB_BACKEND=sqlite/);
    assert.doesNotMatch(productionCompose, /node|next|runner-cli/i);
  });

  it("keeps Node and Next.js out of the Rust runtime image", async () => {
    const dockerfile = await read("Dockerfile.rust");
    const runtime = dockerfile.slice(dockerfile.lastIndexOf("FROM debian:"));

    assert.ok(runtime.includes('ENTRYPOINT ["red-routerd"]'));
    assert.match(dockerfile, /protobuf-compiler/);
    assert.ok(
      runtime.includes(
        "COPY --from=dashboard-builder --chown=redrouter:redrouter /src/.build/rust-dashboard/ /app/dashboard/"
      )
    );
    assert.doesNotMatch(runtime, /\b(?:node|npm|next)\b/i);
  });

  it("deploys red-routerd and the SPA directly on Fly", async () => {
    const fly = await read("fly.toml");
    assert.match(fly, /dockerfile = 'Dockerfile\.rust'/);
    assert.match(fly, /app = 'red-routerd'/);
    assert.match(fly, /internal_port = 25050/);
    assert.doesNotMatch(fly, /node|run-standalone|next/i);
  });

  it("makes the packaged CLI fail closed on the single Rust runtime", async () => {
    const serve = await read("bin/cli/commands/serve.mjs");
    const resolver = await read("bin/cli/runtime/rustRuntime.mjs");

    assert.match(serve, /--runtime <runtime>/);
    assert.match(serve, /resolveRustRuntime/);
    assert.doesNotMatch(serve, /auto, rust, or next/);
    assert.doesNotMatch(resolver, /selected === "next"|kind: "next"/);
    assert.match(resolver, /if \(rust\) return rust/);
    assert.match(resolver, /Rust runtime is not installed/);
    assert.match(resolver, /rust-runtime.*dashboard/s);
  });
});
