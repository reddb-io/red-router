import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
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
        "/api/admin/provider-health",
        "/api/admin/provider-quotas",
        "/api/admin/combos",
        "/api/admin/client-keys",
        "/api/admin/budgets",
        "/api/usage-sinks/types",
      ]) {
        assert.ok(javascript.includes(route), `missing Rust API ${route}`);
      }
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  }
);

async function sourceFiles(directory) {
  const entries = await readdir(directory);
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry);
      return (await stat(path)).isDirectory()
        ? sourceFiles(path)
        : /\.(?:ts|tsx)$/.test(entry)
          ? [path]
          : [];
    })
  );
  return nested.flat();
}

test("Rust SPA does not import the Next.js App Router", async () => {
  const files = await sourceFiles(resolve("rust-dashboard"));
  const sources = await Promise.all(files.map((file) => readFile(file, "utf8")));
  for (const source of sources) {
    assert.doesNotMatch(source, /(?:from|import\s*\()\s*["'][^"']*src\/app\//);
    assert.doesNotMatch(source, /next\/(?:navigation|headers|server|image|link)/);
    assert.doesNotMatch(source, /(?:from|import\s*\()\s*["']@\//);
    assert.doesNotMatch(source, /(?:from|import\s*\()\s*["'][^"']*\bsrc\//);
  }
});

test("Rust production image builds the SPA without copying the Next source tree", async () => {
  const dockerfile = await readFile(resolve("Dockerfile.rust"), "utf8");
  assert.doesNotMatch(dockerfile, /^COPY\s+src\s+/m);
  assert.match(dockerfile, /^COPY\s+rust-dashboard\s+\.\/rust-dashboard$/m);
});
