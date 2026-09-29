import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { getLatestVersion as getCliLatestVersion } from "../../../bin/cli/commands/update.mjs";
import {
  getLatestVersionFromGitHub,
  getLatestVersionFromNpmCli,
  getLatestVersionFromRegistry,
} from "../../../src/lib/system/versionCheck.ts";
import { APP_CONFIG } from "../../../src/shared/constants/appConfig.ts";

test("all version lookup channels use the RedRouter release identity", async () => {
  let npmArgs: string[] = [];
  await getLatestVersionFromNpmCli(async (_command, args) => {
    npmArgs = args as string[];
    return { stdout: '"0.34.4"', stderr: "" };
  });
  assert.deepEqual(npmArgs.slice(0, 3), ["info", "@reddb-io/red-router", "version"]);

  let cliArgs: string[] = [];
  await getCliLatestVersion(async (_command: string, args: string[]) => {
    cliArgs = args;
    return { stdout: "0.34.4", stderr: "" };
  });
  assert.deepEqual(cliArgs.slice(0, 3), ["view", "@reddb-io/red-router", "version"]);

  let registryUrl = "";
  await getLatestVersionFromRegistry(async (input) => {
    registryUrl = String(input);
    return Response.json({ version: "0.34.4" });
  });
  assert.equal(registryUrl, "https://registry.npmjs.org/%40reddb-io%2Fred-router/latest");

  let githubUrl = "";
  await getLatestVersionFromGitHub(async (input) => {
    githubUrl = String(input);
    return Response.json({ tag_name: "v0.34.4" });
  });
  assert.equal(githubUrl, "https://api.github.com/repos/reddb-io/red-router/releases/latest");
});

test("dashboard update cannot install an upstream package or switch the main worktree", () => {
  const route = readFileSync(join(process.cwd(), "src/app/api/system/version/route.ts"), "utf8");
  const home = readFileSync(
    join(process.cwd(), "src/app/(dashboard)/dashboard/HomePageClient.tsx"),
    "utf8"
  );
  const cli = readFileSync(join(process.cwd(), "bin/cli/commands/update.mjs"), "utf8");

  assert.equal(APP_CONFIG.name, "RedRouter");
  assert.match(route, /autoUpdateSupported: false/);
  assert.match(route, /status: 409/);
  assert.doesNotMatch(route, /git checkout|omniroute@|launchAutoUpdate/);
  assert.doesNotMatch(home, /diegosouzapw\/OmniRoute|downloadUpdate\(|checkForUpdates\(/);
  assert.match(home, /reddb-io\/red-router\/releases/);
  assert.doesNotMatch(cli, /npm install -g omniroute|execSync\(/);
  assert.match(cli, /Automatic install is disabled/);
});
