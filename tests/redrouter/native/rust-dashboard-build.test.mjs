import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "vite";

test(
  "Rust dashboard builds a standalone static bundle with the migrated pages",
  { timeout: 120_000 },
  async () => {
    const output = await mkdtemp(join(tmpdir(), "redrouter-dashboard-"));
    try {
      await build({
        configFile: resolve("rust-dashboard/vite.config.mjs"),
        logLevel: "error",
        build: { outDir: output, emptyOutDir: false },
      });
      const html = await readFile(join(output, "index.html"), "utf8");
      assert.match(html, /<div id="root"><\/div>/);
      assert.match(html, /\/assets\/[^" ]+\.js/);
      const files = await readdir(join(output, "assets"));
      assert.ok(
        files.some((file) => file.endsWith(".css")),
        "dashboard stylesheet is emitted"
      );
      const javascript = (
        await Promise.all(
          files
            .filter((file) => file.endsWith(".js"))
            .map((file) => readFile(join(output, "assets", file), "utf8"))
        )
      ).join("\n");
      for (const route of [
        "/api/auth/config",
        "/api/auth/local/login",
        "/api/admin/providers",
        "/api/admin/combos",
        "/api/admin/client-keys",
        "/api/usage-sinks/types",
      ]) {
        assert.ok(javascript.includes(route), `missing Rust API ${route}`);
      }
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  }
);
