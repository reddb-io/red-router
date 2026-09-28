import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { getDefaultDataDir } from "../../../bin/cli/data-dir.mjs";
import { DEFAULT_HOST, DEFAULT_PORT } from "../../../bin/cli/product.mjs";
import {
  buildLaunchdPlist,
  buildServiceArgs,
  buildSystemdUnit,
  LINUX_SERVICE_NAME,
} from "../../../bin/cli/service.mjs";
import { resolveServerHost } from "../../../bin/cli/utils/serverHost.mjs";

const root = process.cwd();

test("RedRouter restores its v0.33 runtime defaults and identity", () => {
  assert.equal(DEFAULT_PORT, 25050);
  assert.equal(DEFAULT_HOST, "127.0.0.1");
  assert.equal(resolveServerHost({}, "linux", "workstation"), DEFAULT_HOST);
  assert.equal(
    resolveServerHost({ RED_ROUTER_SERVER_HOST: "192.0.2.10" }, "linux", "workstation"),
    "192.0.2.10"
  );
  assert.equal(
    getDefaultDataDir(),
    process.platform === "win32"
      ? join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "red", "router")
      : join(homedir(), ".red", "router")
  );

  const program = readFileSync(join(root, "bin/cli/program.mjs"), "utf8");
  assert.match(program, /\.name\("red-router"\)/);
  assert.doesNotMatch(program, /\.name\("omniroute"\)/);
});

test("service install contract matches red-dev on Linux and macOS", () => {
  assert.equal(LINUX_SERVICE_NAME, "red-router.service");
  assert.deepEqual(buildServiceArgs(), [
    "serve",
    "--port",
    "25050",
    "--host",
    "127.0.0.1",
    "--no-open",
  ]);

  const unit = buildSystemdUnit({
    nodePath: "/opt/node/bin/node",
    cliPath: "/opt/red-router/bin/omniroute.mjs",
    dataDir: "/home/test/.red/router",
  });
  assert.match(unit, /Description=RedRouter AI routing gateway/);
  assert.match(unit, /ExecStart=.*serve.*--port.*25050.*--host.*127\.0\.0\.1/);
  assert.match(unit, /Environment="DATA_DIR=\/home\/test\/\.red\/router"/);
  assert.match(unit, /Type=notify/);
  assert.match(unit, /WatchdogSec=180/);
  assert.doesNotMatch(unit, /omniroute\.service|\.omniroute/);

  const plist = buildLaunchdPlist({
    nodePath: "/opt/node/bin/node",
    cliPath: "/opt/red-router/bin/omniroute.mjs",
    dataDir: "/Users/test/.red/router",
  });
  assert.match(plist, /io\.reddb\.red-router/);
  assert.match(plist, /<string>25050<\/string>/);
  assert.match(plist, /<string>127\.0\.0\.1<\/string>/);
});

test("service command and release consumer smoke are package-owned gates", () => {
  const registry = readFileSync(join(root, "bin/cli/commands/registry.mjs"), "utf8");
  const workflow = readFileSync(join(root, ".github/workflows/red-publish.yml"), "utf8");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

  assert.match(registry, /registerService\(program\)/);
  assert.equal(pkg.scripts["test:unit"], "node scripts/test/run-redrouter.mjs native");
  assert.equal(pkg.scripts["test:unit:ci"], "node scripts/test/run-redrouter.mjs native");
  assert.match(workflow, /mise exec -- red-router service --help/);
});
