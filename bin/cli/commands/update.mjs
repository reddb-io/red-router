import { execFile } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { serviceStatus, readServiceConfiguration } from "../service.mjs";
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
    .option("--apply", "Update a verified npm or mise installation and refresh its service")
    .option("--changelog", "Show the GitHub release URL")
    .option("--dry-run", "Show package-manager update guidance")
    .action(async (opts) => {
      const exitCode = await runUpdateCommand(opts);
      if (exitCode !== 0) process.exitCode = exitCode;
    });
}

export async function runUpdateCommand(opts = {}, dependencies = {}) {
  const current = getCurrentVersion();
  if (!current) {
    console.error("Could not determine the installed RedRouter version.");
    return 1;
  }

  const latest = await (dependencies.latest ?? getLatestVersion)();
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
  if (opts.apply && !opts.dryRun) {
    const execFn = dependencies.exec ?? execFileAsync;
    const channel = await (dependencies.detect ?? detectInstallationChannel)(execFn);
    if (!channel || !/^\d+\.\d+\.\d+$/.test(latest)) {
      console.error(
        "Automatic update requires a verified npm-global or mise installation. Use the package manager that installed this CLI."
      );
      return 1;
    }
    try {
      const status = (dependencies.status ?? serviceStatus)();
      const config = readServiceConfiguration();
      if (channel.kind === "npm") {
        await execFn(
          npmBin(),
          ["install", "--global", `${PACKAGE_NAME}@${latest}`],
          npmExecOptions(process.platform, { timeoutMs: 300_000 })
        );
      } else {
        await execFn("mise", ["upgrade", `npm:${PACKAGE_NAME}`], {
          timeout: 300_000,
          shell: false,
        });
      }
      const refreshed = await (dependencies.detect ?? detectInstallationChannel)(execFn, {
        afterUpdate: true,
      });
      if (!refreshed || refreshed.kind !== channel.kind)
        throw new Error("Installation location could not be verified after updating");
      const metadata = JSON.parse(readFileSync(path.join(refreshed.root, "package.json"), "utf8"));
      if (metadata.version !== latest)
        throw new Error("Package manager did not activate the expected version");
      if (status.installed) {
        const args = [path.join(refreshed.root, "bin", "omniroute.mjs"), "service", "install"];
        if (config) args.push("--port", String(config.port), "--host", config.host);
        await execFn(process.execPath, args, { timeout: 360_000, shell: false });
      }
      console.log(
        `Updated ${PACKAGE_NAME} to ${latest}${status.installed ? " and verified its service" : ""}.`
      );
      return 0;
    } catch {
      console.error(
        "Update did not complete. Inspect your package manager, then run red-router service install and red-router doctor."
      );
      return 1;
    }
  }
  return opts.check && outdated ? 1 : 0;
}

/** Compare physical locations before selecting a package manager; source/npx installs stay manual. */
export async function detectInstallationChannel(
  execFn = execFileAsync,
  { afterUpdate = false, packageRoot = PACKAGE_ROOT } = {}
) {
  let current;
  try {
    current = realpathSync(packageRoot);
  } catch {
    return null;
  }
  try {
    const { stdout } = await execFn("mise", ["where", `npm:${PACKAGE_NAME}`], {
      timeout: 15_000,
      shell: false,
    });
    const installRoot = String(stdout).trim();
    const root = realpathSync(path.join(installRoot, "lib", "node_modules", PACKAGE_NAME));
    if (
      root === current ||
      (afterUpdate && current.includes(`${path.sep}mise${path.sep}installs${path.sep}`))
    )
      return { kind: "mise", root };
  } catch {
    /* Not the selected mise installation. */
  }
  try {
    const { stdout } = await execFn(
      npmBin(),
      ["root", "--global"],
      npmExecOptions(process.platform, { timeoutMs: 15_000 })
    );
    const root = realpathSync(path.join(String(stdout).trim(), PACKAGE_NAME));
    if (root === current) return { kind: "npm", root };
  } catch {
    /* Not a global npm installation. */
  }
  return null;
}
