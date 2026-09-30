/**
 * Persistence of WireGuard egress profiles.
 *
 * Each profile is two `key_value` rows in the `settings` namespace, both under `_`-prefixed keys
 * that `getSettings()` skips, so nothing here can leak through GET /api/settings, PATCH responses
 * or settings audit diffs (same convention as `namedTunnelConfig.ts` and `metricsToken.ts`):
 *
 *   `_wireguardEgressProfile:<id>`  non-secret metadata (JSON, plaintext)
 *   `_wireguardEgressSecret:<id>`   the WireGuard private key, the optional preshared key and the
 *                                   loopback SOCKS5 credentials, as one `encrypt()`ed JSON blob
 *
 * Secrets are only readable through `readWireGuardEgressSecrets()` / `readWireGuardEgressModel()`,
 * which the process supervisor calls to render the wireproxy config. Every value returned by a
 * list/get function is a `WireGuardEgressProfile`, which has no secret field, only
 * `hasPrivateKey` / `hasPresharedKey` flags.
 */

import { randomBytes, randomUUID } from "crypto";
import { getDbInstance } from "./core";
import { decrypt, encrypt } from "./encryption";
import type { WgEgressModel } from "@/lib/wireguard/egressConfig";

const PROFILE_PREFIX = "_wireguardEgressProfile:";
const SECRET_PREFIX = "_wireguardEgressSecret:";
export const MAX_EGRESS_PROFILES = 16;

type StoredProfile = {
  id: string;
  name: string;
  enabled: boolean;
  socksPort: number;
  proxyId: string | null;
  endpointHost: string;
  endpointPort: number;
  publicKey: string;
  addresses: string[];
  dns: string[];
  mtu: number | null;
  allowedIps: string[];
  persistentKeepalive: number | null;
  hasPresharedKey: boolean;
  createdAt: string;
  updatedAt: string;
};

/** Everything the API and the dashboard may see. There is deliberately no key or password field. */
export type WireGuardEgressProfile = Omit<StoredProfile, "hasPresharedKey"> & {
  hasPrivateKey: true;
  hasPresharedKey: boolean;
};

type StoredSecrets = {
  privateKey: string;
  presharedKey: string | null;
  socksUsername: string;
  socksPassword: string;
};

export class EgressProfileError extends Error {
  code: "duplicate_name" | "limit_reached" | "not_found" | "invalid_name";
  constructor(code: EgressProfileError["code"]) {
    super(code);
    this.name = "EgressProfileError";
    this.code = code;
  }
}

function assertId(id: string): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new EgressProfileError("not_found");
}

function readRaw(key: string): string | null {
  const row = getDbInstance()
    .prepare("SELECT value FROM key_value WHERE namespace = 'settings' AND key = ?")
    .get(key) as { value?: unknown } | undefined;
  return row && typeof row.value === "string" ? row.value : null;
}

function writeRaw(key: string, value: string): void {
  getDbInstance()
    .prepare("INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('settings', ?, ?)")
    .run(key, value);
}

function deleteRaw(key: string): void {
  getDbInstance()
    .prepare("DELETE FROM key_value WHERE namespace = 'settings' AND key = ?")
    .run(key);
}

function parseStored(raw: string | null): StoredProfile | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredProfile>;
    if (!value || typeof value !== "object" || typeof value.id !== "string") return null;
    return value as StoredProfile;
  } catch {
    return null;
  }
}

function toPublic(stored: StoredProfile): WireGuardEgressProfile {
  const { hasPresharedKey, ...rest } = stored;
  return { ...rest, hasPrivateKey: true, hasPresharedKey };
}

function writeStored(stored: StoredProfile): void {
  writeRaw(PROFILE_PREFIX + stored.id, JSON.stringify(stored));
}

function readStored(id: string): StoredProfile | null {
  assertId(id);
  return parseStored(readRaw(PROFILE_PREFIX + id));
}

function listStored(): StoredProfile[] {
  const rows = getDbInstance()
    .prepare(
      "SELECT value FROM key_value WHERE namespace = 'settings' AND key GLOB '_wireguardEgressProfile:*'"
    )
    .all() as Array<{ value?: unknown }>;
  return rows
    .map((row) => parseStored(typeof row.value === "string" ? row.value : null))
    .filter((profile): profile is StoredProfile => profile !== null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name));
}

export function normalizeEgressProfileName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (!name || name.length > 64 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new EgressProfileError("invalid_name");
  }
  return name;
}

export function listWireGuardEgressProfiles(): WireGuardEgressProfile[] {
  return listStored().map(toPublic);
}

export function getWireGuardEgressProfile(id: string): WireGuardEgressProfile | null {
  const stored = readStored(id);
  return stored ? toPublic(stored) : null;
}

/** Ports already claimed by saved profiles, so a new pick never collides with a sibling. */
export function listWireGuardEgressPorts(): number[] {
  return listStored().map((profile) => profile.socksPort);
}

export type CreateWireGuardEgressInput = {
  name: string;
  model: WgEgressModel;
  socksPort: number;
};

export function createWireGuardEgressProfile(
  input: CreateWireGuardEgressInput
): WireGuardEgressProfile {
  const name = normalizeEgressProfileName(input.name);
  const db = getDbInstance();
  return db.transaction(() => {
    const existing = listStored();
    if (existing.length >= MAX_EGRESS_PROFILES) throw new EgressProfileError("limit_reached");
    if (existing.some((profile) => profile.name.toLowerCase() === name.toLowerCase())) {
      throw new EgressProfileError("duplicate_name");
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    const { model } = input;
    const stored: StoredProfile = {
      id,
      name,
      enabled: false,
      socksPort: input.socksPort,
      proxyId: null,
      endpointHost: model.peer.endpointHost,
      endpointPort: model.peer.endpointPort,
      publicKey: model.peer.publicKey,
      addresses: [...model.addresses],
      dns: [...model.dns],
      mtu: model.mtu,
      allowedIps: [...model.peer.allowedIps],
      persistentKeepalive: model.peer.persistentKeepalive,
      hasPresharedKey: model.peer.presharedKey !== null,
      createdAt: now,
      updatedAt: now,
    };
    const secrets: StoredSecrets = {
      privateKey: model.privateKey,
      presharedKey: model.peer.presharedKey,
      // Loopback SOCKS5 credentials: another local process cannot ride the tunnel.
      socksUsername: `rr${randomBytes(6).toString("hex")}`,
      socksPassword: randomBytes(18).toString("base64url"),
    };
    writeRaw(SECRET_PREFIX + id, JSON.stringify(encrypt(JSON.stringify(secrets)) as string));
    writeStored(stored);
    return toPublic(stored);
  })();
}

export type UpdateWireGuardEgressInput = Partial<{
  name: string;
  enabled: boolean;
  socksPort: number;
  proxyId: string | null;
}>;

export function updateWireGuardEgressProfile(
  id: string,
  patch: UpdateWireGuardEgressInput
): WireGuardEgressProfile | null {
  const db = getDbInstance();
  return db.transaction(() => {
    const current = readStored(id);
    if (!current) return null;
    const next: StoredProfile = { ...current };
    if (patch.name !== undefined) {
      const name = normalizeEgressProfileName(patch.name);
      if (
        listStored().some(
          (profile) => profile.id !== id && profile.name.toLowerCase() === name.toLowerCase()
        )
      ) {
        throw new EgressProfileError("duplicate_name");
      }
      next.name = name;
    }
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    if (patch.socksPort !== undefined) next.socksPort = patch.socksPort;
    if (patch.proxyId !== undefined) next.proxyId = patch.proxyId;
    next.updatedAt = new Date().toISOString();
    writeStored(next);
    return toPublic(next);
  })();
}

export function deleteWireGuardEgressProfile(id: string): boolean {
  assertId(id);
  const db = getDbInstance();
  return db.transaction(() => {
    const existed = readRaw(PROFILE_PREFIX + id) !== null;
    deleteRaw(PROFILE_PREFIX + id);
    deleteRaw(SECRET_PREFIX + id);
    return existed;
  })();
}

/** Decrypted secrets, or null. Callers must never log or return them. */
export function readWireGuardEgressSecrets(id: string): StoredSecrets | null {
  assertId(id);
  const raw = readRaw(SECRET_PREFIX + id);
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw);
    if (typeof stored !== "string") return null;
    const plain = decrypt(stored);
    if (!plain) return null;
    const value = JSON.parse(plain) as Partial<StoredSecrets>;
    if (
      typeof value.privateKey !== "string" ||
      typeof value.socksUsername !== "string" ||
      typeof value.socksPassword !== "string"
    ) {
      return null;
    }
    return {
      privateKey: value.privateKey,
      presharedKey: typeof value.presharedKey === "string" ? value.presharedKey : null,
      socksUsername: value.socksUsername,
      socksPassword: value.socksPassword,
    };
  } catch {
    return null;
  }
}

/** The full model (secrets included) for rendering the wireproxy config. Never return this. */
export function readWireGuardEgressModel(
  id: string
): {
  model: WgEgressModel;
  socksUsername: string;
  socksPassword: string;
  socksPort: number;
} | null {
  const stored = readStored(id);
  const secrets = readWireGuardEgressSecrets(id);
  if (!stored || !secrets) return null;
  return {
    socksPort: stored.socksPort,
    socksUsername: secrets.socksUsername,
    socksPassword: secrets.socksPassword,
    model: {
      privateKey: secrets.privateKey,
      addresses: stored.addresses,
      dns: stored.dns,
      mtu: stored.mtu,
      peer: {
        publicKey: stored.publicKey,
        presharedKey: secrets.presharedKey,
        endpointHost: stored.endpointHost,
        endpointPort: stored.endpointPort,
        allowedIps: stored.allowedIps,
        persistentKeepalive: stored.persistentKeepalive,
      },
    },
  };
}
