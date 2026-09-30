/**
 * WireGuard key material with `node:crypto` only (no `wg` binary, no root).
 *
 * WireGuard keys are raw 32-byte Curve25519 values in standard base64 (44 characters, one `=`).
 * Node exposes X25519 as DER/JWK, so the raw bytes are taken from the JWK (`d` private, `x` public,
 * base64url) and re-encoded as standard base64. A private key is imported back through the fixed
 * PKCS#8 wrapper for X25519 (RFC 8410), which lets a stored key be turned into its public key again.
 *
 * Nothing here logs or persists anything; callers own the lifetime of the returned strings.
 */

import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";

const KEY_BYTES = 32;

// DER prefix of a PKCS#8 PrivateKeyInfo holding a 32-byte X25519 key (RFC 8410).
const PKCS8_X25519_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

export type WireGuardKeyPair = { privateKey: string; publicKey: string };

function base64UrlToBase64(value: string): string {
  return Buffer.from(value, "base64url").toString("base64");
}

/** Strict decode: standard base64, canonical padding, exactly 32 bytes. Null when not a key. */
function decodeKey(value: unknown): Buffer | null {
  if (typeof value !== "string" || value.length !== 44) return null;
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) return null;
  const raw = Buffer.from(value, "base64");
  if (raw.length !== KEY_BYTES) return null;
  // Rejects non-canonical trailing bits: the value must re-encode to itself.
  return raw.toString("base64") === value ? raw : null;
}

/** True for a WireGuard private, public or preshared key: canonical base64 of exactly 32 bytes. */
export function isWireGuardKey(value: unknown): value is string {
  return decodeKey(value) !== null;
}

/** Curve25519 clamping, as `wg genkey` applies it. Idempotent, and it does not change the public key. */
function clamp(raw: Buffer): Buffer {
  const out = Buffer.from(raw);
  out[0] &= 248;
  out[31] &= 127;
  out[31] |= 64;
  return out;
}

/** The public key belonging to a private key (what `wg pubkey` prints). */
export function derivePublicKey(privateKey: string): string {
  const raw = decodeKey(privateKey);
  if (!raw) throw new Error("Not a WireGuard private key");
  const keyObject = createPrivateKey({
    key: Buffer.concat([PKCS8_X25519_PREFIX, raw]),
    format: "der",
    type: "pkcs8",
  });
  const jwk = createPublicKey(keyObject).export({ format: "jwk" });
  if (typeof jwk.x !== "string") throw new Error("Could not derive the public key");
  return base64UrlToBase64(jwk.x);
}

/** A fresh X25519 keypair in WireGuard's encoding. */
export function generateKeyPair(): WireGuardKeyPair {
  const { privateKey } = generateKeyPairSync("x25519");
  const jwk = privateKey.export({ format: "jwk" });
  if (typeof jwk.d !== "string") throw new Error("Could not generate a WireGuard key");
  const privateB64 = clamp(Buffer.from(jwk.d, "base64url")).toString("base64");
  return { privateKey: privateB64, publicKey: derivePublicKey(privateB64) };
}

/** A fresh preshared key: 32 random bytes, base64. */
export function generatePresharedKey(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}
