// GET /api/oauth/cursor/auto-import — reads Cursor's local state.vscdb.
// Strategy order: in-process SQLite (better-sqlite3 below Node 24, else node:sqlite) → sqlite3 CLI → manual.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fsPromises from "fs/promises";
import * as childProcess from "child_process";

vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((body, init) => ({ status: init?.status || 200, body, json: async () => body })),
  },
}));

vi.mock("os", () => ({
  default: { homedir: vi.fn(() => "/mock/home") },
  homedir: vi.fn(() => "/mock/home"),
}));

vi.mock("fs/promises", () => ({
  access: vi.fn(),
  constants: { R_OK: 4 },
}));

// promisify(execFile) calls execFile(file, args, options, callback).
vi.mock("child_process", () => ({ execFile: vi.fn() }));

const STORE = {
  "cursorAuth/accessToken": JSON.stringify("tok-123"),
  "storage.serviceMachineId": "machine-abc",
};

// In-process readers. better-sqlite3 is used below Node 24, node:sqlite from 24 on
// (the native addon crashes there); the tests pin the Node version to pick one.
const sqlite = vi.hoisted(() => ({ rows: {}, failOpen: false, opened: [] }));
const fakeDb = (driver) => {
  if (sqlite.failOpen) throw new Error("cannot open database");
  sqlite.opened.push(driver);
  return {
    prepare: () => ({ get: (key) => (key in sqlite.rows ? { value: sqlite.rows[key] } : undefined) }),
    close() {},
  };
};
vi.mock("better-sqlite3", () => ({ default: function Database() { return fakeDb("better-sqlite3"); } }));
vi.mock("node:sqlite", () => ({ DatabaseSync: function DatabaseSync() { return fakeDb("node:sqlite"); } }));

function stubSqlite(rows, { failOpen = false } = {}) {
  sqlite.rows = rows;
  sqlite.failOpen = failOpen;
}

const realVersions = process.versions;
const pinNode = (node) => Object.defineProperty(process, "versions", {
  value: { ...realVersions, node, bun: undefined }, configurable: true,
});

// sqlite3 CLI: answers SELECT value ... WHERE key='<k>' from `rows`; `which` from `whichOk`.
function stubExecFile({ rows = null, whichOk = true } = {}) {
  vi.mocked(childProcess.execFile).mockImplementation((file, args, _opts, cb) => {
    if (file === "which") return whichOk ? cb(null, { stdout: "/usr/bin/cursor" }) : cb(new Error("not found"));
    if (file === "sqlite3" && rows) {
      const key = /key='([^']+)'/.exec(args[1])?.[1];
      return cb(null, { stdout: rows[key] ?? "" });
    }
    return cb(new Error("sqlite3: command not found"));
  });
}

let GET;
const originalPlatform = process.platform;
const setPlatform = (value) => Object.defineProperty(process, "platform", { value, writable: true });

describe("GET /api/oauth/cursor/auto-import", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    sqlite.opened = [];
    stubSqlite({});
    pinNode("22.12.0");
    setPlatform("darwin");
    stubExecFile();
    ({ GET } = await import("../../src/app/api/oauth/cursor/auto-import/route.js"));
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    Object.defineProperty(process, "versions", { value: realVersions, configurable: true });
  });

  it("reports every macOS location it checked when no database is readable", async () => {
    vi.mocked(fsPromises.access).mockRejectedValue(new Error("ENOENT"));

    const { body } = await GET();

    expect(body.found).toBe(false);
    expect(body.error).toContain("Cursor database not found");
    expect(body.error).toContain("/mock/home/Library/Application Support/Cursor/User/globalStorage/state.vscdb");
    expect(body.error).toContain("Cursor - Insiders");
  });

  it("extracts tokens with better-sqlite3 below Node 24 and unwraps JSON-encoded values", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    stubSqlite(STORE);

    const { body } = await GET();

    expect(body).toEqual({ found: true, accessToken: "tok-123", machineId: "machine-abc" });
    expect(sqlite.opened).toEqual(["better-sqlite3"]);
  });

  it("uses node:sqlite from Node 24 on, never loading better-sqlite3", async () => {
    pinNode("26.10.0");
    vi.mocked(fsPromises.access).mockResolvedValue();
    stubSqlite(STORE);

    const { body } = await GET();

    expect(body).toEqual({ found: true, accessToken: "tok-123", machineId: "machine-abc" });
    expect(sqlite.opened).toEqual(["node:sqlite"]);
  });

  it("falls back to the sqlite3 CLI when no in-process reader can open the file", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    stubSqlite(STORE, { failOpen: true });
    stubExecFile({ rows: { "cursorAuth/token": JSON.stringify("tok-cli"), "telemetry.machineId": "m-cli" } });

    const { body } = await GET();

    expect(body).toEqual({ found: true, accessToken: "tok-cli", machineId: "m-cli" });
  });

  it("asks for manual entry when neither strategy finds both tokens", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    stubSqlite({ "cursorAuth/accessToken": "tok-only" });

    const { body } = await GET();

    expect(body).toMatchObject({ found: false, windowsManual: true });
    expect(body.dbPath).toContain("state.vscdb");
  });

  it("on Linux, skips leftover config when Cursor is not installed", async () => {
    setPlatform("linux");
    vi.mocked(fsPromises.access).mockImplementation(async (p) => {
      if (String(p).endsWith("cursor.desktop")) throw new Error("ENOENT");
    });
    stubExecFile({ whichOk: false });

    const { body } = await GET();

    expect(body.found).toBe(false);
    expect(body.error).toContain("does not appear to be installed");
  });

  it("on Linux, imports when Cursor is installed", async () => {
    setPlatform("linux");
    vi.mocked(fsPromises.access).mockResolvedValue();
    stubSqlite(STORE);

    const { body } = await GET();

    expect(body).toEqual({ found: true, accessToken: "tok-123", machineId: "machine-abc" });
  });
});
