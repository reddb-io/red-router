import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildDefaultDataDir,
  buildLegacyDataDirs,
  migrateLegacyDataDirs,
} from "../../src/lib/dataDir.js";
import { relocateLegacyDbLayout } from "../../src/lib/db/paths.js";

const tmpRoots = [];

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rr-mig-home-"));
  tmpRoots.push(home);
  return home;
}

afterEach(() => {
  while (tmpRoots.length) {
    try {
      fs.rmSync(tmpRoots.pop(), { recursive: true, force: true });
    } catch {}
  }
});

describe("data dir layout (~/.red/router)", () => {
  it("resolves the default dir under ~/.red/router", () => {
    expect(buildDefaultDataDir({ homedir: "/home/x", platform: "linux" })).toBe("/home/x/.red/router");
  });

  it("resolves legacy dirs: previous RedRouter layout first, official 9router origin second", () => {
    expect(buildLegacyDataDirs({ homedir: "/home/x", platform: "linux" })).toEqual([
      "/home/x/.red-router",
      "/home/x/.9router",
    ]);
  });

  it("renames the whole legacy dir when the target does not exist", () => {
    const home = makeHome();
    fs.mkdirSync(path.join(home, ".red-router"));
    fs.writeFileSync(path.join(home, ".red-router", "data.sqlite"), "db");
    const target = migrateLegacyDataDirs(path.join(home, ".red", "router"), { homedir: home, platform: "linux" });
    expect(target).toBe(path.join(home, ".red", "router"));
    expect(fs.existsSync(path.join(home, ".red", "router", "data.sqlite"))).toBe(true);
    expect(fs.existsSync(path.join(home, ".red-router"))).toBe(false);
  });

  it("prefers the RedRouter dir and merges 9router-origin entries not already present", () => {
    const home = makeHome();
    fs.mkdirSync(path.join(home, ".red-router"));
    fs.writeFileSync(path.join(home, ".red-router", "data.sqlite"), "new");
    fs.mkdirSync(path.join(home, ".9router"));
    fs.writeFileSync(path.join(home, ".9router", "usage.json"), "{}");
    const target = migrateLegacyDataDirs(path.join(home, ".red", "router"), { homedir: home, platform: "linux" });
    expect(fs.readFileSync(path.join(target, "data.sqlite"), "utf8")).toBe("new");
    expect(fs.existsSync(path.join(target, "usage.json"))).toBe(true);
    expect(fs.existsSync(path.join(home, ".red-router"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".9router"))).toBe(false);
  });

  it("keeps existing target entries over legacy ones (runtime/ seeded by postinstall)", () => {
    const home = makeHome();
    const target = path.join(home, ".red", "router");
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(path.join(target, "runtime"));
    fs.mkdirSync(path.join(home, ".red-router"));
    fs.writeFileSync(path.join(home, ".red-router", "runtime"), "old");
    migrateLegacyDataDirs(target, { homedir: home, platform: "linux" });
    expect(fs.existsSync(path.join(target, "runtime"))).toBe(true);
    expect(fs.statSync(path.join(target, "runtime")).isDirectory()).toBe(true);
  });

  it("is a no-op when no legacy dir exists", () => {
    const home = makeHome();
    const target = path.join(home, ".red", "router");
    expect(migrateLegacyDataDirs(target, { homedir: home, platform: "linux" })).toBe(target);
    expect(fs.existsSync(target)).toBe(false);
  });
});

describe("legacy db/ layout relocation", () => {
  it("moves db/data.sqlite (and backups) to the data dir root", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rr-mig-db-"));
    tmpRoots.push(dir);
    fs.mkdirSync(path.join(dir, "db", "backups"), { recursive: true });
    fs.writeFileSync(path.join(dir, "db", "data.sqlite"), "db");
    fs.writeFileSync(path.join(dir, "db", "backups", "b.sql"), "b");
    expect(relocateLegacyDbLayout(dir)).toBe(true);
    expect(fs.readFileSync(path.join(dir, "data.sqlite"), "utf8")).toBe("db");
    expect(fs.readFileSync(path.join(dir, "backups", "b.sql"), "utf8")).toBe("b");
    expect(fs.existsSync(path.join(dir, "db"))).toBe(false);
  });

  it("is a no-op when data.sqlite already lives at the root", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rr-mig-db-"));
    tmpRoots.push(dir);
    fs.mkdirSync(path.join(dir, "db"), { recursive: true });
    fs.writeFileSync(path.join(dir, "data.sqlite"), "current");
    fs.writeFileSync(path.join(dir, "db", "data.sqlite"), "stale");
    expect(relocateLegacyDbLayout(dir)).toBe(false);
    expect(fs.readFileSync(path.join(dir, "data.sqlite"), "utf8")).toBe("current");
  });

  it("is a no-op on a fresh dir", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rr-mig-db-"));
    tmpRoots.push(dir);
    expect(relocateLegacyDbLayout(dir)).toBe(false);
  });
});
