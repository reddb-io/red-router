import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { findLeftovers, sweepLine } from "../../../scripts/dev/brand-sweep.mjs";

// Every user-visible place the product is named. Compatibility identifiers (OMNIROUTE_* variables,
// X-OmniRoute-* headers, ~/.omniroute, prompt markers other tools read back, the MITM certificate
// name) and upstream attribution are intentionally out of reach of the sweep; see COMPAT_LINE in
// scripts/dev/brand-sweep.mjs. A new leftover here means new user-visible text names the old product.
const AREAS = [
  "src/app",
  "src/shared",
  "src/lib",
  "src/mitm",
  "src/server",
  "src/sse",
  "src/domain",
  "src/i18n",
  "open-sse",
  "bin",
  "electron",
  "public",
  "llm.txt",
  "docs/architecture",
  "docs/guides",
  "docs/reference",
  "docs/frameworks",
  "docs/routing",
  "docs/security",
  "docs/compression",
  "docs/ops",
  "docs/openapi.yaml",
  ".env.example",
];

test("no user-visible text names the inherited product", () => {
  assert.deepEqual(findLeftovers(AREAS), []);
});

test("the sweep renames prose and commands but leaves compatibility identifiers", () => {
  assert.equal(
    sweepLine('  "Connect OmniRoute to your IDE"', ".json"),
    '  "Connect RedRouter to your IDE"'
  );
  assert.equal(sweepLine("Run `omniroute setup` first", ".md"), "Run `red-router setup` first");
  assert.equal(sweepLine("Use an OmniRoute key", ".md"), "Use a RedRouter key");
  assert.equal(sweepLine('  "OmniProxy"', ".json"), '  "Proxy"');
  for (const line of [
    'const header = "X-OmniRoute-Budget";',
    "export OMNIROUTE_PORT=20128",
    "data dir ~/.omniroute/storage.sqlite",
    'const marker = "[OmniRoute Caveman Output Mode]";',
    'const name = "OmniRoute MITM CA";',
    'id.startsWith("custom:OmniRoute")',
    'content.includes("managed by OmniRoute")',
  ]) {
    assert.equal(sweepLine(line, ".ts"), line, line);
  }
  assert.equal(
    sweepLine("// OmniRoute compatibility note", ".ts"),
    "// OmniRoute compatibility note"
  );
});

test("the setup diagram and public metadata carry the product name", () => {
  for (const theme of ["light", "dark"]) {
    const svg = fs.readFileSync(`public/images/tier-flow-${theme}.svg`, "utf8");
    assert.match(svg, /RedRouter 4-tier fallback/);
    assert.doesNotMatch(svg, /OmniRoute/);
  }
  assert.match(fs.readFileSync("public/sw.js", "utf8"), /title: "RedRouter"/);
  assert.match(fs.readFileSync("docs/openapi.yaml", "utf8"), /^\s*title: RedRouter API/m);
});
