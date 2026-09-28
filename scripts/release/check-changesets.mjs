// CI-only real-tool integration: never versions the actual checkout.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChangesets } from "./changesets.mjs";

const fixture = await mkdtemp(join(tmpdir(), "redrouter-version-check-"));
try {
  const manifest = {
    name: "@reddb-io/red-router",
    version: "0.34.0",
    workspaces: ["private-engine"],
  };
  await writeFile(join(fixture, "package.json"), JSON.stringify(manifest));
  await writeFile(
    join(fixture, "package-lock.json"),
    JSON.stringify({
      name: manifest.name,
      version: manifest.version,
      lockfileVersion: 3,
      packages: { "": manifest, "private-engine": { name: "engine", version: "9.9.9" } },
    })
  );
  await mkdir(join(fixture, ".changeset"));
  await cp(
    new URL("../../.changeset/config.json", import.meta.url),
    join(fixture, ".changeset/config.json")
  );
  await writeFile(
    join(fixture, ".changeset/check.md"),
    '---\n"@reddb-io/red-router": patch\n---\n\nCheck root versioning.\n'
  );
  await runChangesets("version", { root: fixture });
  const result = JSON.parse(await readFile(join(fixture, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(join(fixture, "package-lock.json"), "utf8"));
  assert.equal(result.version, "0.34.1");
  assert.deepEqual(result.workspaces, manifest.workspaces);
  assert.equal(lock.packages[""].version, result.version);
  assert.equal(lock.version, result.version);
  assert.equal(lock.packages["private-engine"].version, "9.9.9");
  assert.match(await readFile(join(fixture, "CHANGELOG.md"), "utf8"), /Check root versioning/);
} finally {
  await rm(fixture, { recursive: true, force: true });
}
