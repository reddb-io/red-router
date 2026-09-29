import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { npmBin, npmExecOptions } from "../npm-exec.mjs";

const execFileAsync = promisify(execFile);
const PACKAGE_NAME = "@reddb-io/red-router";
const RELEASES_URL = "https://github.com/reddb-io/red-router/releases";
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function isNewer(latest, current) {
  const parse = (value) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value)?.slice(1).map(Number);
  const next = parse(latest);
  const installed = parse(current);
  if (!next || !installed) return false;
  for (let i = 0; i < 3; i += 1) {
    if (next[i] !== installed[i]) return next[i] > installed[i];
  }
  return false;
}

export function getCurrentVersion() {
  try {
    return JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")).version;
  } catch {
    return null;
  }
}

export async function getLatestVersion(execFn = execFileAsync) {
  try {
    const { stdout } = await execFn(
      npmBin(),
      ["view", PACKAGE_NAME, "version", "--prefer-online"],
      npmExecOptions(process.platform, { timeoutMs: 15_000 })
    );
    return String(stdout).trim() || null;
  } catch {
    return null;
  }
}

export function registerUpdate(program) {
  program
    .command("update")
    .description("Check for a newer RedRouter release")
    .option("--check", "Exit 1 when a newer version is available")
    .option("--apply", "Show package-manager update guidance")
    .option("--changelog", "Show the GitHub release URL")
    .option("--dry-run", "Show package-manager update guidance")
    .action(async (opts) => {
      const exitCode = await runUpdateCommand(opts);
      if (exitCode !== 0) process.exitCode = exitCode;
    });
}

export async function runUpdateCommand(opts = {}) {
  const current = getCurrentVersion();
  if (!current) {
    console.error("Could not determine the installed RedRouter version.");
    return 1;
  }

  const latest = await getLatestVersion();
  if (!latest) {
    console.error(`Could not check ${PACKAGE_NAME} on npm.`);
    return 1;
  }

  if (opts.changelog) {
    console.log(`${RELEASES_URL}/tag/v${latest}`);
    return 0;
  }

  console.log(`RedRouter ${current}; latest ${latest}.`);
  const outdated = isNewer(latest, current);
  if (outdated || opts.apply || opts.dryRun) {
    console.log("Update with your existing package manager: mise upgrade");
    console.log(`Or, for a direct npm installation: npm install -g ${PACKAGE_NAME}@latest`);
  }
  if (opts.apply) {
    console.error(
      "Automatic install is disabled: the CLI cannot safely identify your installation channel."
    );
    return 1;
  }
  return opts.check && outdated ? 1 : 0;
}
