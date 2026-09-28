#!/usr/bin/env node
/** Recover the exact npm tarball after GitHub has replaced an earlier run artifact. */
import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

import { hashes, tarballName } from "./artifact.mjs";

const exec = promisify(execFile);
const name = "@reddb-io/red-router";
const repository = "https://github.com/reddb-io/red-router";
const workflow = ".github/workflows/red-publish.yml";
const version = process.env.RELEASE_VERSION;
const sourceSha = process.env.RELEASE_SHA;
const tag = process.env.RELEASE_TAG;
const runId = process.env.RELEASE_RUN_ID;
const attempt = process.env.RELEASE_RUN_ATTEMPT;

function requireIdentity() {
  if (
    !/^0\.\d+\.\d+$/.test(version ?? "") ||
    !/^[a-f0-9]{40}$/.test(sourceSha ?? "") ||
    tag !== `v${version}` ||
    !/^[1-9]\d*$/.test(runId ?? "") ||
    !/^[1-9]\d*$/.test(attempt ?? "")
  ) {
    throw new Error("Invalid published release recovery identity");
  }
}

async function readJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Registry returned HTTP ${response.status}`);
  return response.json();
}

function readStatement(attestation) {
  const encoded = attestation?.bundle?.dsseEnvelope?.payload;
  if (typeof encoded !== "string") return null;
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
}

async function main() {
  requireIdentity();
  const encodedName = "@reddb-io%2fred-router";
  const metadata = await readJson(`https://registry.npmjs.org/${encodedName}/${version}`);
  const expectedTarball = `https://registry.npmjs.org/@reddb-io/red-router/-/red-router-${version}.tgz`;
  const expectedAttestations = `https://registry.npmjs.org/-/npm/v1/attestations/${encodedName}@${version}`;
  const dist = metadata?.dist;
  if (
    metadata?.name !== name ||
    metadata?.version !== version ||
    dist?.tarball !== expectedTarball ||
    dist?.attestations?.url !== expectedAttestations ||
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(dist?.integrity ?? "")
  ) {
    throw new Error("Published package metadata does not match the tagged release");
  }

  const expectedDigest = Buffer.from(dist.integrity.slice(7), "base64").toString("hex");
  const attestations = await readJson(expectedAttestations);
  const provenance = attestations?.attestations?.find(
    (item) => item.predicateType === "https://slsa.dev/provenance/v1"
  );
  const statement = readStatement(provenance);
  const definition = statement?.predicate?.buildDefinition;
  const source = definition?.resolvedDependencies?.find(
    (dependency) =>
      dependency.uri === `git+${repository}@refs/tags/${tag}` &&
      dependency.digest?.gitCommit === sourceSha
  );
  if (
    !statement?.subject?.some(
      (subject) =>
        subject.name === `pkg:npm/%40reddb-io/red-router@${version}` &&
        subject.digest?.sha512 === expectedDigest
    ) ||
    definition?.externalParameters?.workflow?.repository !== repository ||
    definition?.externalParameters?.workflow?.path !== workflow ||
    definition?.externalParameters?.workflow?.ref !== `refs/tags/${tag}` ||
    !source ||
    statement?.predicate?.runDetails?.metadata?.invocationId !==
      `${repository}/actions/runs/${runId}/attempts/${attempt}`
  ) {
    throw new Error("Published provenance does not match the original tagged workflow run");
  }

  const directory = join(process.cwd(), "release-artifacts");
  await mkdir(directory, { recursive: true });
  const tarball = join(directory, tarballName(version));
  const response = await fetch(expectedTarball, { signal: AbortSignal.timeout(180000) });
  if (!response.ok || !response.body) {
    throw new Error(`Published tarball returned HTTP ${response.status}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(tarball, { flags: "wx" }));
  const digest = await hashes(tarball);
  if (digest.integrity !== dist.integrity) {
    throw new Error("Published tarball checksum differs from npm metadata and provenance");
  }
  const { stdout } = await exec("tar", ["-xOf", tarball, "package/package.json"], {
    maxBuffer: 1024 * 1024,
  });
  const manifest = JSON.parse(stdout);
  if (
    manifest.name !== name ||
    manifest.version !== version ||
    manifest.bin?.["red-router"] !== "bin/omniroute.mjs"
  ) {
    throw new Error("Published tarball contains a different package manifest");
  }
  await writeFile(join(directory, "SHA256SUMS"), `${digest.sha256}  ${tarballName(version)}\n`);
  console.log(`Recovered published ${name}@${version} from ${runId}/attempts/${attempt}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
