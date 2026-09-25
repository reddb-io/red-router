import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { networkStatus, readNetworkMode, writeNetworkMode } from "../../src/lib/networkAccess.js";

const require = createRequire(import.meta.url);
const cliNetwork = require("../../cli/src/cli/network.js");

const lan = { eth0: [{ family: "IPv4", internal: false, address: "192.168.1.20" }], lo: [{ family: "IPv4", internal: true, address: "127.0.0.1" }] };
let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "rr-network-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe("network access setting (CLI launcher)", () => {
  const env = () => ({ DATA_DIR: dir });

  it("binds a --host flag first, then the saved setting, then the launcher default", () => {
    expect(cliNetwork.resolveHost({ defaultHost: "0.0.0.0", env: env() })).toEqual({ host: "0.0.0.0", source: "default" });
    cliNetwork.writeNetworkMode("local", env());
    expect(cliNetwork.resolveHost({ defaultHost: "0.0.0.0", env: env() })).toEqual({ host: "127.0.0.1", source: "setting" });
    expect(cliNetwork.resolveHost({ flagHost: "0.0.0.0", defaultHost: "127.0.0.1", env: env() })).toEqual({ host: "0.0.0.0", source: "flag" });
  });

  it("ignores an unreadable or unknown saved value, and refuses to save one", () => {
    fs.writeFileSync(path.join(dir, "network.json"), "{not json");
    expect(cliNetwork.readNetworkMode(env())).toBeNull();
    fs.writeFileSync(path.join(dir, "network.json"), JSON.stringify({ mode: "everywhere" }));
    expect(cliNetwork.readNetworkMode(env())).toBeNull();
    expect(() => cliNetwork.writeNetworkMode("everywhere", env())).toThrow(/Unknown network mode/);
  });

  it("reads what the dashboard saves, and the dashboard reads what the CLI saves", () => {
    writeNetworkMode("network", dir);
    expect(cliNetwork.readNetworkMode(env())).toBe("network");
    cliNetwork.writeNetworkMode("local", env());
    expect(readNetworkMode(dir)).toBe("local");
  });
});

describe("network status (dashboard)", () => {
  it("reports the bound address, LAN URLs and a saved choice waiting for a restart", () => {
    writeNetworkMode("local", dir);
    const status = networkStatus({ dir, interfaces: lan, env: { HOSTNAME: "0.0.0.0", PORT: "25050", RED_ROUTER_LAUNCHER: "1", RED_ROUTER_HOST_SOURCE: "default" } });
    expect(status).toMatchObject({ mode: "local", host: "0.0.0.0", exposed: true, canRestart: true, pinned: false, pending: true, urls: ["http://192.168.1.20:25050"] });
  });

  it("is not pending when a --host flag pins this run, and says so", () => {
    writeNetworkMode("local", dir);
    const status = networkStatus({ dir, interfaces: lan, env: { HOSTNAME: "0.0.0.0", RED_ROUTER_LAUNCHER: "1", RED_ROUTER_HOST_SOURCE: "flag" } });
    expect(status).toMatchObject({ source: "flag", pinned: true, pending: false });
  });

  it("cannot restart a server the CLI launcher does not run", () => {
    const status = networkStatus({ dir, interfaces: lan, env: { HOSTNAME: "127.0.0.1" } });
    expect(status).toMatchObject({ source: "env", pinned: true, canRestart: false, exposed: false, urls: [] });
  });
});

describe("PUT /api/settings/network", () => {
  it("saves a valid mode and rejects anything else", async () => {
    const { PUT } = await import("../../src/app/api/settings/network/route.js");
    const put = (body) => PUT(new Request("http://localhost/api/settings/network", { method: "PUT", body: JSON.stringify(body) }));
    expect((await put({ mode: "everywhere" })).status).toBe(400);
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {});
    const res = await put({ mode: "network", restart: true });
    expect(res.status).toBe(200);
    // Not run by the CLI launcher here: nothing restarts it, so it must not exit.
    expect((await res.json()).restarting).toBe(false);
    expect(readNetworkMode()).toBe("network");
    expect(exit).not.toHaveBeenCalled();
  });
});
