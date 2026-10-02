import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyArtifact } from "./artifact.mjs";

const exec = promisify(execFile);

export function selectMainRun(runs, sha) {
  return runs.find(
    (run) =>
      run.head_sha === sha &&
      run.head_branch === "main" &&
      run.event === "push" &&
      run.status === "completed" &&
      run.conclusion === "success"
  );
}

export async function promoteMainArtifact(env = process.env) {
  const repo = env.GITHUB_REPOSITORY;
  const sha = env.RELEASE_SHA;
  const version = env.RELEASE_VERSION;
  if (repo !== "reddb-io/red-router" || !/^[a-f0-9]{40}$/.test(sha || "")) {
    throw new Error("Invalid main artifact source identity");
  }
  const api = async (path) => {
    const { stdout } = await exec("gh", ["api", path], { maxBuffer: 8 * 1024 * 1024 });
    return JSON.parse(stdout);
  };
  const { workflow_runs: runs } = await api(
    `repos/${repo}/actions/workflows/red-publish.yml/runs?head_sha=${sha}&branch=main&event=push&status=success&per_page=100`
  );
  const run = selectMainRun(runs, sha);
  if (!run) throw new Error("No successful main CI run for this exact tagged commit");
  const name = `redrouter-release-${run.id}-${run.run_attempt}`;
  const { artifacts } = await api(`repos/${repo}/actions/runs/${run.id}/artifacts?per_page=100`);
  if (!artifacts.some((artifact) => artifact.name === name && !artifact.expired)) {
    throw new Error("The successful main run attempt has no available release artifact");
  }
  await exec("gh", [
    "run",
    "download",
    String(run.id),
    "--repo",
    repo,
    "--name",
    name,
    "--dir",
    "release-artifacts",
  ]);
  await verifyArtifact("release-artifacts", {
    sourceSha: sha,
    version,
    runId: String(run.id),
    runAttempt: String(run.run_attempt),
  });
  await appendFile(env.GITHUB_OUTPUT, `run_id=${run.id}\nrun_attempt=${run.run_attempt}\n`);
  console.log(`Promoted the verified main artifact from run ${run.id}, attempt ${run.run_attempt}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  promoteMainArtifact().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
