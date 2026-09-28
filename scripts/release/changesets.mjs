import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CHANGESETS_CLI = "@changesets/cli@3.0.3";
const projectRoot = fileURLToPath(new URL("../../", import.meta.url));

export function releasePackage(manifest) {
  if (manifest.name !== "@reddb-io/red-router" || !/^0\.\d+\.\d+$/.test(manifest.version)) {
    throw new Error("Expected the canonical RedRouter source package and stable v0.x version");
  }
  // Changesets' npm workspace discovery excludes the root package. Version the
  // root deliverable in isolation; private engine/browser workspaces are not releases.
  return { name: manifest.name, version: manifest.version, private: false };
}

async function execute(args, cwd) {
  await new Promise((accept, reject) => {
    const child = spawn(
      process.platform === "win32" ? "npm.cmd" : "npm",
      [
        "exec",
        "--yes",
        "--workspaces=false",
        "--package=" + CHANGESETS_CLI,
        "--",
        "changeset",
        ...args,
      ],
      { cwd, stdio: "inherit" }
    );
    child.on("error", reject);
    child.on("exit", (code, signal) =>
      code === 0 ? accept() : reject(new Error(`Changesets failed: ${signal || code}`))
    );
  });
}

export async function runChangesets(command, { root = projectRoot, args = [] } = {}) {
  if (!["add", "status", "version"].includes(command))
    throw new Error("Use add, status or version");
  if (command === "version" && args.length) throw new Error("Version options are not supported");
  const files = ["package.json", "package-lock.json", "CHANGELOG.md"];
  const changesets = await readdir(join(root, ".changeset"));
  files.push(
    ...changesets.filter((name) => /\.(md|json)$/.test(name)).map((name) => ".changeset/" + name)
  );
  const original = new Map();
  for (const file of files) {
    try {
      original.set(file, await readFile(join(root, file), "utf8"));
    } catch (error) {
      if (file !== "CHANGELOG.md" || error.code !== "ENOENT") throw error;
      original.set(file, null);
    }
  }
  const manifest = JSON.parse(original.get("package.json"));
  const stage = await mkdtemp(join(tmpdir(), "redrouter-changesets-"));
  let completed = false;
  try {
    await writeFile(
      join(stage, "package.json"),
      JSON.stringify(releasePackage(manifest), null, 2) + "\n"
    );
    await cp(join(root, ".changeset"), join(stage, ".changeset"), { recursive: true });
    if (original.get("CHANGELOG.md") !== null) {
      await writeFile(join(stage, "CHANGELOG.md"), original.get("CHANGELOG.md"));
    }
    await execute([command, ...args], stage);
    if (command !== "status") {
      // Do not overwrite edits made while an interactive Changesets command ran.
      for (const [file, content] of original) {
        const current = await readFile(join(root, file), "utf8").catch((error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (current !== content)
          throw new Error(`Concurrent edit: ${file}; result retained in ${stage}`);
      }
      const result = JSON.parse(await readFile(join(stage, "package.json"), "utf8"));
      releasePackage(result);
      if (command === "version") {
        if (result.version === manifest.version)
          throw new Error("Changesets did not produce a version change");
        manifest.version = result.version;
        const lock = JSON.parse(original.get("package-lock.json"));
        lock.name = manifest.name;
        lock.version = manifest.version;
        lock.packages[""].name = manifest.name;
        lock.packages[""].version = manifest.version;
        await writeFile(join(root, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
        await writeFile(join(root, "package-lock.json"), JSON.stringify(lock, null, 2) + "\n");
        await cp(join(stage, "CHANGELOG.md"), join(root, "CHANGELOG.md"));
      }
      const remaining = (await readdir(join(stage, ".changeset"))).filter((name) =>
        name.endsWith(".md")
      );
      for (const name of remaining) {
        if (!changesets.includes(name)) {
          await writeFile(
            join(root, ".changeset", name),
            await readFile(join(stage, ".changeset", name)),
            { flag: "wx" }
          );
        }
      }
      if (command === "version") {
        for (const name of changesets.filter(
          (name) => name.endsWith(".md") && !remaining.includes(name)
        )) {
          await unlink(join(root, ".changeset", name));
        }
      }
    }
    completed = true;
  } finally {
    if (completed) await rm(stage, { recursive: true, force: true });
    else console.error(`Changesets workspace retained for diagnosis: ${stage}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runChangesets(process.argv[2] || "add", { args: process.argv.slice(3) }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
