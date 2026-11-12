import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const read = (path) => readFile(new URL(`../../../${path}`, import.meta.url), "utf8");

describe("Rust production entrypoint", () => {
  it("exposes explicit build and start commands for the Rust server and SPA", async () => {
    const pkg = JSON.parse(await read("package.json"));

    expect(pkg.scripts["build:rust"]).toContain("build:rust-dashboard");
    expect(pkg.scripts["build:rust"]).toContain("build:rust-server");
    expect(pkg.scripts["build:rust-server"]).toContain("rust/red-routerd/Cargo.toml");
    expect(pkg.scripts["start:rust"]).toContain("RED_ROUTER_SPA_DIR=.build/rust-dashboard");
    expect(pkg.scripts["start:rust"]).toContain("rust/red-routerd/Cargo.toml");
  });

  it("defines a loopback-bound Rust and SQLite compose profile", async () => {
    const compose = await read("docker-compose.yml");
    const service = compose.match(/  redrouter-rust:\r?\n([\s\S]*?)(?=\r?\n  # ── Redis)/)?.[1];

    expect(service).toBeDefined();
    expect(service).toContain("dockerfile: Dockerfile.rust");
    expect(service).toContain("RED_ROUTER_DB_BACKEND=sqlite");
    expect(service).toContain("RED_ROUTER_SPA_DIR=/app/dashboard");
    expect(service).toContain("${APP_BIND_HOST:-127.0.0.1}");
    expect(service).toContain("- rust");
    expect(service).not.toMatch(/node|next/i);
  });

  it("keeps Node and Next.js out of the Rust runtime image", async () => {
    const dockerfile = await read("Dockerfile.rust");
    const runtime = dockerfile.slice(dockerfile.lastIndexOf("FROM debian:"));

    expect(runtime).toContain('ENTRYPOINT ["red-routerd"]');
    expect(runtime).toContain(
      "COPY --from=dashboard-builder --chown=redrouter:redrouter /src/.build/rust-dashboard/ /app/dashboard/"
    );
    expect(runtime).not.toMatch(/\b(?:node|npm|next)\b/i);
  });
});
