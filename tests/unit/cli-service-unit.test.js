import { describe, expect, it } from "vitest";
import {
  DEFAULT_SERVICE_HOST,
  buildLaunchdPlist,
  buildSystemdUnit,
  launcherArgs,
} from "../../cli/service.js";

const opts = {
  nodePath: "/usr/local/bin/node",
  cliPath: "/opt/red-router/cli.js",
  port: 25050,
  host: "127.0.0.1",
};

describe("cli service definitions", () => {
  it("defaults the service to local-only binding", () => {
    expect(DEFAULT_SERVICE_HOST).toBe("127.0.0.1");
  });

  it("launcher args run headless with update checks disabled", () => {
    expect(launcherArgs({ port: 25050, host: "127.0.0.1" })).toEqual([
      "-p",
      "25050",
      "-H",
      "127.0.0.1",
      "--skip-update",
      "-n",
    ]);
  });

  it("systemd unit supervises the launcher with the requested port/host", () => {
    const unit = buildSystemdUnit(opts);
    expect(unit).toContain("Description=RedRouter");
    expect(unit).toContain('ExecStart="/usr/local/bin/node" "/opt/red-router/cli.js" "-p" "25050" "-H" "127.0.0.1"');
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("WantedBy=default.target");
  });

  it("launchd plist keeps the gateway alive across reboots", () => {
    const plist = buildLaunchdPlist(opts);
    expect(plist).toContain("<string>io.reddb.red-router</string>");
    expect(plist).toContain("<string>/usr/local/bin/node</string>");
    expect(plist).toContain("<string>-H</string>\n      <string>127.0.0.1</string>");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>KeepAlive</key>");
  });

  it("escapes XML entities in paths for the plist", () => {
    const plist = buildLaunchdPlist({ ...opts, cliPath: "/opt/Apps & Tools/cli.js" });
    expect(plist).toContain("/opt/Apps &amp; Tools/cli.js");
    expect(plist).not.toContain("/opt/Apps & Tools/cli.js");
  });
});
