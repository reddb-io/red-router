/**
 * wireproxy binary management for WireGuard egress: detection, and an explicit, verified install.
 *
 * Detection order: `WIREPROXY_BIN` (operator override), the RedRouter-managed copy in
 * `<DATA_DIR>/wireguard-egress/bin`, then `wireproxy` on PATH.
 *
 * Install is opt-in (an explicit API call, never implicit on enable) and FAILS CLOSED:
 *   - the release asset URL is built from a pinned version and a fixed GitHub path in this file;
 *   - the SHA-256 of the downloaded archive must equal a checksum pinned IN THIS FILE for that
 *     exact asset. A checksum fetched from the same host as the archive proves nothing, so none is
 *     ever fetched or trusted (unlike the GitHub `digest` field the cloudflared installer reads);
 *   - an asset with no pinned checksum is refused BEFORE any network request;
 *   - nothing downloaded is written to disk, extracted or executed until the digest matches.
 */

import { execFile } from "child_process";
import { createHash } from "crypto";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { promisify } from "util";
import { resolveDataDir } from "@/lib/dataPaths";

const execFileAsync = promisify(execFile);

/** Pinned wireproxy release. Bump together with the checksum table below. */
export const WIREPROXY_VERSION = "v1.0.9";
const WIREPROXY_RELEASE_BASE = "https://github.com/pufferffish/wireproxy/releases/download";
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;

export type WireproxyAsset = { assetName: string; binaryName: string };

/** Official release archives, by `process.platform` then `process.arch`. Names follow the upstream release page. */
const ASSET_MATRIX: Record<string, Record<string, WireproxyAsset>> = {
  linux: {
    x64: { assetName: "wireproxy_linux_amd64.tar.gz", binaryName: "wireproxy" },
    arm64: { assetName: "wireproxy_linux_arm64.tar.gz", binaryName: "wireproxy" },
    arm: { assetName: "wireproxy_linux_arm.tar.gz", binaryName: "wireproxy" },
  },
  darwin: {
    x64: { assetName: "wireproxy_darwin_amd64.tar.gz", binaryName: "wireproxy" },
    arm64: { assetName: "wireproxy_darwin_arm64.tar.gz", binaryName: "wireproxy" },
  },
  win32: {
    x64: { assetName: "wireproxy_windows_amd64.tar.gz", binaryName: "wireproxy.exe" },
    arm64: { assetName: "wireproxy_windows_arm64.tar.gz", binaryName: "wireproxy.exe" },
  },
};

/**
 * SHA-256 (lower-case hex) of each release archive of `WIREPROXY_VERSION`, keyed by asset name.
 *
 * INTENTIONALLY EMPTY until a maintainer fills it from a checksum they verified themselves
 * (download the asset from the official release page, hash it locally, compare with the release's
 * own checksums, then paste the value). While an entry is missing the managed install refuses to
 * run for that platform; an operator can still install wireproxy by hand and RedRouter finds it.
 */
export const WIREPROXY_SHA256: Readonly<Record<string, string>> = {};

export const NO_VERIFIED_CHECKSUM_MESSAGE =
  "No verified checksum for this platform yet. Install wireproxy yourself and RedRouter will find it on PATH.";

export type WireproxyInstallErrorCode =
  | "unsupported_platform"
  | "no_verified_checksum"
  | "download_failed"
  | "checksum_mismatch"
  | "extract_failed";

const INSTALL_MESSAGES: Record<WireproxyInstallErrorCode, string> = {
  unsupported_platform:
    "wireproxy has no official build for this operating system or architecture.",
  no_verified_checksum: NO_VERIFIED_CHECKSUM_MESSAGE,
  download_failed: "Could not download wireproxy.",
  checksum_mismatch:
    "The downloaded wireproxy archive did not match the pinned checksum and was discarded.",
  extract_failed: "Could not unpack the downloaded wireproxy archive.",
};

/** Carries a fixed, public-safe message and a stable code; never the underlying error text. */
export class WireproxyInstallError extends Error {
  code: WireproxyInstallErrorCode;
  constructor(code: WireproxyInstallErrorCode) {
    super(INSTALL_MESSAGES[code]);
    this.name = "WireproxyInstallError";
    this.code = code;
  }
}

export type WireproxySource = "env" | "managed" | "path";

export type WireproxyResolution = {
  binaryPath: string | null;
  source: WireproxySource | null;
  managed: boolean;
};

/** What the dashboard may see. No filesystem paths. */
export type WireproxyBinaryStatus = {
  installed: boolean;
  source: WireproxySource | null;
  supported: boolean;
  /** True when this platform has a pinned checksum, i.e. the Install button can work. */
  installable: boolean;
  version: string;
  platform: string;
  message: string | null;
};

export type WireproxyBinaryRuntime = {
  platform: string;
  arch: string;
  checksums: Readonly<Record<string, string>>;
  /** Fetch the archive. Must return the raw bytes; verification happens in the caller. */
  download: (url: string) => Promise<Buffer>;
  /** Extract exactly the named member of a .tar.gz into `destinationDir`. */
  extract: (archivePath: string, destinationDir: string, member: string) => Promise<void>;
  which: (command: string) => Promise<string | null>;
  binDir: () => string;
};

export function getWireGuardEgressRootDir(): string {
  return path.join(resolveDataDir(), "wireguard-egress");
}

async function defaultDownload(url: string): Promise<Buffer> {
  const { default: proxyFetch } = await import("@omniroute/open-sse/utils/proxyFetch.ts");
  const response = await proxyFetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`status ${response.status}`);
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_DOWNLOAD_BYTES) throw new Error("too large");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_DOWNLOAD_BYTES) throw new Error("too large");
  return buffer;
}

async function defaultExtract(archivePath: string, destinationDir: string, member: string) {
  // Only the one named member is extracted, so no other archive entry can write anywhere.
  await execFileAsync("tar", ["-xzf", archivePath, "-C", destinationDir, member], {
    timeout: 20_000,
  });
}

async function defaultWhich(command: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      process.platform === "win32" ? "where" : "which",
      [command],
      {
        timeout: 3000,
      }
    );
    return (
      stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) || null
    );
  } catch {
    return null;
  }
}

const defaultRuntime = (): WireproxyBinaryRuntime => ({
  platform: process.platform,
  arch: process.arch,
  checksums: WIREPROXY_SHA256,
  download: defaultDownload,
  extract: defaultExtract,
  which: defaultWhich,
  binDir: () => path.join(getWireGuardEgressRootDir(), "bin"),
});

let runtime: WireproxyBinaryRuntime = defaultRuntime();

/** Test seam: override download/extract/which/checksums, or pass `null` to restore the real ones. */
export function setWireproxyBinaryRuntime(overrides: Partial<WireproxyBinaryRuntime> | null): void {
  runtime = overrides ? { ...defaultRuntime(), ...overrides } : defaultRuntime();
}

export function getWireproxyAssetSpec(
  platform = runtime.platform,
  arch = runtime.arch
): WireproxyAsset | null {
  return ASSET_MATRIX[platform]?.[arch] ?? null;
}

export function getWireproxyDownloadUrl(asset: WireproxyAsset): string {
  return `${WIREPROXY_RELEASE_BASE}/${WIREPROXY_VERSION}/${asset.assetName}`;
}

function getManagedBinaryPath(): string {
  const name = runtime.platform === "win32" ? "wireproxy.exe" : "wireproxy";
  return path.join(runtime.binDir(), name);
}

/** Throws unless the SHA-256 of `buffer` equals `expectedSha256` (case-insensitive hex). */
export function verifyWireproxyDigest(buffer: Buffer, expectedSha256: string): void {
  const actual = createHash("sha256").update(buffer).digest("hex");
  if (!/^[0-9a-f]{64}$/i.test(expectedSha256) || actual !== expectedSha256.toLowerCase()) {
    throw new WireproxyInstallError("checksum_mismatch");
  }
}

export async function resolveWireproxyBinary(): Promise<WireproxyResolution> {
  const envPath = String(process.env.WIREPROXY_BIN || "").trim();
  if (envPath && fsSync.existsSync(envPath)) {
    return { binaryPath: envPath, source: "env", managed: false };
  }
  const managedPath = getManagedBinaryPath();
  if (fsSync.existsSync(managedPath)) {
    return { binaryPath: managedPath, source: "managed", managed: true };
  }
  const onPath = await runtime.which("wireproxy");
  if (onPath) return { binaryPath: onPath, source: "path", managed: false };
  return { binaryPath: null, source: null, managed: false };
}

export async function getWireproxyBinaryStatus(): Promise<WireproxyBinaryStatus> {
  const resolved = await resolveWireproxyBinary();
  const asset = getWireproxyAssetSpec();
  const installable = !!asset && /^[0-9a-f]{64}$/i.test(runtime.checksums[asset.assetName] ?? "");
  let message: string | null = null;
  if (!resolved.binaryPath) {
    if (!asset) message = INSTALL_MESSAGES.unsupported_platform;
    else if (!installable) message = NO_VERIFIED_CHECKSUM_MESSAGE;
  }
  return {
    installed: !!resolved.binaryPath,
    source: resolved.source,
    supported: !!asset,
    installable,
    version: WIREPROXY_VERSION,
    platform: `${runtime.platform}/${runtime.arch}`,
    message,
  };
}

let installPromise: Promise<WireproxyResolution> | null = null;

/**
 * Download the pinned asset, verify its pinned SHA-256, and only then unpack it. The temporary
 * archive is deleted whatever happens. Idempotent: an already installed binary is returned as is.
 */
export function installWireproxyBinary(): Promise<WireproxyResolution> {
  if (installPromise) return installPromise;
  installPromise = doInstall().finally(() => {
    installPromise = null;
  });
  return installPromise;
}

async function doInstall(): Promise<WireproxyResolution> {
  const existing = await resolveWireproxyBinary();
  if (existing.binaryPath) return existing;

  const asset = getWireproxyAssetSpec();
  if (!asset) throw new WireproxyInstallError("unsupported_platform");
  // Fail closed BEFORE touching the network when no checksum is pinned for this asset.
  const expected = runtime.checksums[asset.assetName];
  if (typeof expected !== "string" || !/^[0-9a-f]{64}$/i.test(expected)) {
    throw new WireproxyInstallError("no_verified_checksum");
  }

  let archive: Buffer;
  try {
    archive = await runtime.download(getWireproxyDownloadUrl(asset));
  } catch {
    throw new WireproxyInstallError("download_failed");
  }
  verifyWireproxyDigest(archive, expected);

  const binDir = runtime.binDir();
  await fs.mkdir(binDir, { recursive: true, mode: 0o700 });
  const workDir = await fs.mkdtemp(path.join(binDir, ".install-"));
  const archivePath = path.join(workDir, asset.assetName);
  try {
    await fs.writeFile(archivePath, archive, { mode: 0o600 });
    try {
      await runtime.extract(archivePath, workDir, asset.binaryName);
    } catch {
      throw new WireproxyInstallError("extract_failed");
    }
    const extracted = path.join(workDir, asset.binaryName);
    if (!fsSync.existsSync(extracted)) throw new WireproxyInstallError("extract_failed");
    const target = getManagedBinaryPath();
    await fs.rename(extracted, target);
    if (runtime.platform !== "win32") await fs.chmod(target, 0o755);
    return { binaryPath: target, source: "managed", managed: true };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Runtime directory for per-profile config files (0700). Cleaned on start and on stop. */
export function getWireGuardEgressRuntimeDir(): string {
  return path.join(getWireGuardEgressRootDir(), "runtime");
}
