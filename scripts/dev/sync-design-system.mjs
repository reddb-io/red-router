#!/usr/bin/env node
// Run with node --import tsx. Uses the DS producer, never rebuilds its artifacts.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const source = resolve(process.argv[2] || join(root, "../design-system"));
const manifest = JSON.parse(readFileSync(join(root, "design-system.manifest.json"), "utf8"));
const run = promisify(execFile);
const git = async (...args) => (await run("git", ["-C", source, ...args])).stdout;

if (manifest.dest !== "src/shared/design-system/vendor") {
  throw new Error("Refusing to synchronize outside the dedicated DS vendor directory");
}
if ((await git("rev-parse", `v${manifest.version}^{commit}`)).trim() !== manifest.revision) {
  throw new Error("Design system release tag does not match the reviewed revision");
}
if ((await git("rev-parse", "HEAD")).trim() !== manifest.producerRevision) {
  throw new Error("Use the reviewed producer revision from design-system.manifest.json");
}
if ((await git("status", "--porcelain", "--", "scripts/producer")).trim()) {
  throw new Error("The DS producer has local changes; review and pin it before synchronizing");
}

if (manifest.kits.length || manifest.layers.length) {
  throw new Error("This React consumer currently adopts Styles only; route Kits through ds-sync");
}
const producer = (file) => import(pathToFileURL(join(source, "scripts/producer/src", file)).href);
const { planConsumerStyles, writeConsumerStyles } = await producer("consumer-styles.ts");
const { assemblePackage } = await producer("packaging.ts");
const destination = join(root, manifest.dest);
const work = mkdtempSync(join(tmpdir(), "redrouter-ds-sync-"));
try {
  const release = join(work, "release");
  await run("git", [
    "clone",
    "--quiet",
    "--shared",
    "--branch",
    `v${manifest.version}`,
    source,
    release,
  ]);
  const revision = (await run("git", ["-C", release, "rev-parse", "HEAD"])).stdout.trim();
  if (revision !== manifest.revision) throw new Error("Cloned release revision mismatch");
  // Use the exact same producer functions as ds-sync's styles-only path.
  const plan = planConsumerStyles(release, manifest.styles);
  const pkg = assemblePackage(
    JSON.parse(readFileSync(join(release, "package.json"))),
    [],
    [],
    plan.profiles
  );
  writeConsumerStyles(destination, plan);
  writeFileSync(join(destination, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  // The DS style delivery includes font bytes; retain their licenses from the same pin.
  for (const family of ["space-grotesk", "jetbrains-mono"]) {
    const target = join(destination, "licenses", `${family}-OFL.txt`);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(release, "vendor/brand/fonts", family, "OFL.txt"), target);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
function digests(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const name = prefix + entry.name;
      const file = join(directory, entry.name);
      return entry.isDirectory()
        ? digests(file, `${name}/`)
        : [[name, createHash("sha256").update(readFileSync(file)).digest("hex")]];
    });
}
writeFileSync(
  join(root, "design-system.lock.json"),
  JSON.stringify(
    {
      source: manifest.source,
      version: manifest.version,
      revision: manifest.revision,
      producerRevision: manifest.producerRevision,
      files: Object.fromEntries(digests(destination)),
    },
    null,
    2
  ) + "\n"
);
console.log(
  `Synced ${manifest.version}: ${manifest.styles.join(", ")}; no component runtime installed.`
);
