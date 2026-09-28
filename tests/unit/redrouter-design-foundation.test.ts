import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (file: string) => readFileSync(join(root, file), "utf8");
const manifest = JSON.parse(read("design-system.manifest.json"));
const lock = JSON.parse(read("design-system.lock.json"));

function files(directory: string, prefix = ""): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const name = prefix + entry.name;
    return entry.isDirectory() ? files(join(directory, entry.name), `${name}/`) : [name];
  });
}

test("DS styles are pinned and byte-identical, including self-hosted fonts and licenses", () => {
  assert.equal(manifest.source, "reddb-io/design-system");
  assert.match(manifest.revision, /^[0-9a-f]{40}$/);
  assert.equal(lock.revision, manifest.revision);
  assert.equal(lock.producerRevision, manifest.producerRevision);
  assert.equal(lock.version, manifest.version);
  const actual = files(join(root, manifest.dest)).sort();
  assert.deepEqual(actual, Object.keys(lock.files).sort());
  for (const file of actual) {
    const hash = createHash("sha256")
      .update(readFileSync(join(root, manifest.dest, file)))
      .digest("hex");
    assert.equal(hash, lock.files[file], file);
  }
  for (const family of ["space-grotesk", "jetbrains-mono"]) {
    assert.ok(actual.includes(`assets/fonts/${family}-variable.woff2`));
    assert.match(read(`${manifest.dest}/licenses/${family}-OFL.txt`), /SIL OPEN FONT LICENSE/);
  }
});

test("React foundation adoption brings neither Svelte nor component runtime dependencies", () => {
  assert.deepEqual(manifest.kits, []);
  assert.deepEqual(manifest.layers, []);
  assert.deepEqual(manifest.styles, ["application"]);
  const pkg = JSON.parse(read(`${manifest.dest}/package.json`));
  assert.deepEqual(pkg.dependencies || {}, {});
  assert.deepEqual(pkg.peerDependencies || {}, {});
  assert.equal(
    files(join(root, manifest.dest)).some((f) => f.endsWith(".svelte")),
    false
  );
  assert.match(read("src/app/globals.css"), /vendor\/styles\/application\.css/);
  assert.match(read("src/app/layout.tsx"), /data-theme="application"/);
  assert.match(read("src/app/layout.tsx"), /data-density="comfortable"/);
});

test("provider logos are build inputs, not installed production dependencies", () => {
  const pkg = JSON.parse(read("package.json"));
  const npmLock = JSON.parse(read("package-lock.json"));
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    assert.equal(pkg[field]?.["@lobehub/icons"], undefined);
    assert.equal(pkg[field]?.["@lobehub/ui"], undefined);
    assert.equal(pkg[field]?.["@pierre/theme"], undefined);
  }
  assert.ok(pkg.devDependencies["@lobehub/icons"]);
  assert.equal(npmLock.packages["node_modules/@lobehub/icons"].dev, true);
  assert.deepEqual(npmLock.packages[""].dependencies, pkg.dependencies);
  assert.deepEqual(npmLock.packages[""].devDependencies, pkg.devDependencies);
  assert.match(read("next.config.mjs"), /transpilePackages:.*"@lobehub\/icons"/);
});
