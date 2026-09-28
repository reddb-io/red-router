import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
export const PACKAGE_NAME = "@reddb-io/red-router";
export const artifactName = (sha) => `redrouter-release-${sha}`;
export const tarballName = (version) => `reddb-io-red-router-${version}.tgz`;

export async function hashes(file) {
  const sha256 = createHash("sha256");
  const sha512 = createHash("sha512");
  for await (const chunk of createReadStream(file)) {
    sha256.update(chunk);
    sha512.update(chunk);
  }
  return { sha256: sha256.digest("hex"), integrity: "sha512-" + sha512.digest("base64") };
}

export function validateMetadata(metadata, expected = {}) {
  if (
    metadata.schema !== 1 ||
    metadata.packageName !== PACKAGE_NAME ||
    !/^0\.\d+\.\d+$/.test(metadata.version) ||
    !/^[a-f0-9]{40}$/.test(metadata.sourceSha) ||
    metadata.tarball !== tarballName(metadata.version) ||
    !/^[a-f0-9]{64}$/.test(metadata.sha256) ||
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(metadata.integrity)
  ) {
    throw new Error("Invalid RedRouter release metadata");
  }
  for (const [key, value] of Object.entries(expected)) {
    if (value !== undefined && String(metadata[key]) !== String(value)) {
      throw new Error(`Release artifact ${key} mismatch`);
    }
  }
  return metadata;
}

export async function verifyArtifact(directory, expected = {}) {
  const metadata = validateMetadata(
    JSON.parse(await readFile(join(directory, "release.json"), "utf8")),
    expected
  );
  const tarball = join(directory, metadata.tarball);
  const digest = await hashes(tarball);
  if (digest.sha256 !== metadata.sha256 || digest.integrity !== metadata.integrity) {
    throw new Error("Release tarball checksum mismatch");
  }
  const { stdout } = await exec("tar", ["-xOf", tarball, "package/package.json"], {
    maxBuffer: 1024 * 1024,
  });
  const manifest = JSON.parse(stdout);
  if (
    manifest.name !== PACKAGE_NAME ||
    manifest.version !== metadata.version ||
    manifest.bin?.["red-router"] !== "bin/omniroute.mjs"
  ) {
    throw new Error("Packed manifest differs from release identity");
  }
  return { metadata, tarball };
}

export async function packArtifact(root = process.cwd()) {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (manifest.name !== PACKAGE_NAME || !/^0\.\d+\.\d+$/.test(manifest.version)) {
    throw new Error("Version RedRouter with Changesets before building");
  }
  const { stdout: sha } = await exec("git", ["rev-parse", "HEAD"], { cwd: root });
  const buildSha = (await readFile(join(root, "dist/BUILD_SHA"), "utf8")).trim();
  if (!/^[a-f0-9]{7,40}$/.test(buildSha) || !sha.trim().startsWith(buildSha)) {
    throw new Error("The built package does not belong to the current source commit");
  }
  const directory = join(root, "release-artifacts");
  await mkdir(directory, { recursive: true });
  if ((await readdir(directory)).length)
    throw new Error("release-artifacts must be empty before packing");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const { stdout } = await exec(
    npm,
    ["pack", "--json", "--ignore-scripts", "--pack-destination", directory],
    { cwd: root, maxBuffer: 64 * 1024 * 1024 }
  );
  const reports = JSON.parse(stdout);
  if (reports.length !== 1 || reports[0].filename !== tarballName(manifest.version)) {
    throw new Error("npm produced an unexpected tarball");
  }
  const tarball = join(directory, reports[0].filename);
  const digest = await hashes(tarball);
  if (reports[0].integrity !== digest.integrity) throw new Error("npm pack integrity mismatch");
  const metadata = validateMetadata({
    schema: 1,
    packageName: manifest.name,
    version: manifest.version,
    sourceSha: sha.trim(),
    tarball: reports[0].filename,
    ...digest,
    runId: process.env.GITHUB_RUN_ID || "local",
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || "local",
  });
  await writeFile(join(directory, "pack-report.json"), JSON.stringify(reports, null, 2) + "\n");
  await writeFile(join(directory, "release.json"), JSON.stringify(metadata, null, 2) + "\n");
  await writeFile(join(directory, "SHA256SUMS"), `${digest.sha256}  ${metadata.tarball}\n`);
  await verifyArtifact(directory, { sourceSha: sha.trim(), version: manifest.version });
  console.log(`Packed once: ${tarball}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const task =
    process.argv[2] === "pack"
      ? packArtifact()
      : process.argv[2] === "verify"
        ? verifyArtifact(resolve(process.argv[3] || "release-artifacts"), {
            version: process.env.RELEASE_VERSION,
            sourceSha: process.env.RELEASE_SHA,
            runId: process.env.RELEASE_RUN_ID,
            runAttempt: process.env.RELEASE_RUN_ATTEMPT,
          })
        : Promise.reject(new Error("Use pack or verify"));
  task.catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
