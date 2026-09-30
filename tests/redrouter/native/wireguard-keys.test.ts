import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, diffieHellman } from "node:crypto";
import { test } from "node:test";

import {
  derivePublicKey,
  generateKeyPair,
  generatePresharedKey,
  isWireGuardKey,
} from "../../../src/lib/wireguard/keys.ts";

// RFC 7748 section 6.1 (Diffie-Hellman with Curve25519). WireGuard keys are these raw 32 bytes in
// standard base64, so the RFC vectors pin the exact public keys `wg pubkey` prints.
const ALICE_PRIVATE_HEX = "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a";
const ALICE_PUBLIC_HEX = "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a";
const BOB_PRIVATE_HEX = "5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb";
const BOB_PUBLIC_HEX = "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f";
const SHARED_HEX = "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742";

// The same values as literals, so the test does not lean on the conversion it is checking.
const ALICE_PRIVATE = "dwdtCnMYpX08FsFyUbJmRd9ML4frwJkqsXf7pR25LCo=";
const ALICE_PUBLIC = "hSDwCYkwp1R0i33ctD73Wg2/Og0mOBr066SpjqqbTmo=";
const BOB_PRIVATE = "XasIfmJKikt54X+Lg4AO5m87sSkmGLb9HC+LJ/+I4Os=";
const BOB_PUBLIC = "3p7bfXt9wbTTW2HC7OQ1Nz+DQ8hbeGdNrfx+FG+IK08=";

const b64 = (hex: string) => Buffer.from(hex, "hex").toString("base64");

test("the literals used below are the RFC 7748 vectors in WireGuard's encoding", () => {
  assert.equal(b64(ALICE_PRIVATE_HEX), ALICE_PRIVATE);
  assert.equal(b64(ALICE_PUBLIC_HEX), ALICE_PUBLIC);
  assert.equal(b64(BOB_PRIVATE_HEX), BOB_PRIVATE);
  assert.equal(b64(BOB_PUBLIC_HEX), BOB_PUBLIC);
});

test("derivePublicKey reproduces the RFC 7748 public keys (Alice and Bob)", () => {
  assert.equal(derivePublicKey(ALICE_PRIVATE), ALICE_PUBLIC);
  assert.equal(derivePublicKey(BOB_PRIVATE), BOB_PUBLIC);
});

test("keys are interoperable: both sides of the RFC 7748 exchange agree on the RFC shared secret", () => {
  const PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");
  const SPKI = Buffer.from("302a300506032b656e032100", "hex");
  const priv = (b64Key: string) =>
    createPrivateKey({
      key: Buffer.concat([PKCS8, Buffer.from(b64Key, "base64")]),
      format: "der",
      type: "pkcs8",
    });
  const pub = (b64Key: string) =>
    createPublicKey({
      key: Buffer.concat([SPKI, Buffer.from(b64Key, "base64")]),
      format: "der",
      type: "spki",
    });
  const fromAlice = diffieHellman({ privateKey: priv(ALICE_PRIVATE), publicKey: pub(BOB_PUBLIC) });
  const fromBob = diffieHellman({ privateKey: priv(BOB_PRIVATE), publicKey: pub(ALICE_PUBLIC) });
  assert.equal(fromAlice.toString("hex"), SHARED_HEX);
  assert.equal(fromBob.toString("hex"), SHARED_HEX);
});

test("generated keypairs: 44-character base64, clamped, and the public key matches the private key", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 20; i += 1) {
    const pair = generateKeyPair();
    assert.equal(pair.privateKey.length, 44);
    assert.equal(pair.publicKey.length, 44);
    assert.ok(pair.privateKey.endsWith("="));
    assert.ok(isWireGuardKey(pair.privateKey));
    assert.ok(isWireGuardKey(pair.publicKey));
    assert.equal(derivePublicKey(pair.privateKey), pair.publicKey);
    const raw = Buffer.from(pair.privateKey, "base64");
    assert.equal(raw.length, 32);
    assert.equal(raw[0] & 7, 0, "low three bits cleared");
    assert.equal(raw[31] & 128, 0, "top bit cleared");
    assert.equal(raw[31] & 64, 64, "second-highest bit set");
    assert.notEqual(pair.privateKey, pair.publicKey);
    seen.add(pair.privateKey);
  }
  assert.equal(seen.size, 20, "keypairs are not repeated");
});

test("preshared keys are 32 random bytes in base64", () => {
  const a = generatePresharedKey();
  const b = generatePresharedKey();
  assert.ok(isWireGuardKey(a));
  assert.equal(Buffer.from(a, "base64").length, 32);
  assert.notEqual(a, b);
});

test("isWireGuardKey accepts exactly canonical base64 of 32 bytes", () => {
  assert.equal(isWireGuardKey(ALICE_PUBLIC), true);
  const bad: unknown[] = [
    "",
    "short",
    ALICE_PUBLIC.slice(0, 43), // no padding
    `${ALICE_PUBLIC}=`, // too long
    ALICE_PUBLIC.replace("=", "A"), // wrong length once decoded (33 bytes worth)
    ALICE_PUBLIC.replace(/\+|\//, "-"), // url-safe alphabet is not accepted
    `${ALICE_PUBLIC.slice(0, 42)}B=`, // non-canonical trailing bits re-encode differently
    Buffer.alloc(31).toString("base64"),
    Buffer.alloc(33).toString("base64"),
    `${ALICE_PUBLIC}\n`,
    ` ${ALICE_PUBLIC}`,
    null,
    undefined,
    42,
    {},
  ];
  for (const value of bad) assert.equal(isWireGuardKey(value), false, String(value));
  assert.throws(() => derivePublicKey("not a key"));
});
