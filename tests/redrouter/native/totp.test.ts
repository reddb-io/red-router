import assert from "node:assert/strict";
import { test } from "node:test";

const totp = await import("../../../src/lib/auth/totp.ts");

// RFC 6238 appendix B, SHA-1, secret "12345678901234567890" (the 8-digit codes truncated to 6).
const RFC_SECRET = totp.base32Encode(Buffer.from("12345678901234567890", "ascii"));
const RFC_VECTORS: Array<[number, string]> = [
  [59, "287082"],
  [1111111109, "081804"],
  [1111111111, "050471"],
  [1234567890, "005924"],
  [2000000000, "279037"],
  [20000000000, "353130"],
];

test("codes match the RFC 6238 SHA-1 test vectors", () => {
  for (const [seconds, expected] of RFC_VECTORS) {
    assert.equal(totp.totpCode(RFC_SECRET, seconds * 1000), expected, String(seconds));
  }
});

test("base32 round-trips and rejects garbage", () => {
  const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255, 7, 8]);
  assert.deepEqual(totp.base32Decode(totp.base32Encode(bytes)), bytes);
  assert.equal(
    totp.base32Decode("gezd gnbv gy3t qojq").toString("ascii"),
    "12345678901234567890".slice(0, 10)
  );
  assert.throws(() => totp.base32Decode("not*base32"));
});

test("generated secrets are 160 bits and never repeat", () => {
  const a = totp.generateTotpSecret();
  const b = totp.generateTotpSecret();
  assert.equal(totp.base32Decode(a).length, 20);
  assert.notEqual(a, b);
});

test("a code is accepted one step either side and refused beyond", () => {
  const now = 1_700_000_000_000;
  const code = totp.totpCode(RFC_SECRET, now);
  assert.equal(totp.verifyTotp(RFC_SECRET, code, { nowMs: now }), totp.totpStep(now));
  assert.equal(totp.verifyTotp(RFC_SECRET, code, { nowMs: now + 30_000 }), totp.totpStep(now));
  assert.equal(totp.verifyTotp(RFC_SECRET, code, { nowMs: now - 30_000 }), totp.totpStep(now));
  assert.equal(totp.verifyTotp(RFC_SECRET, code, { nowMs: now + 90_000 }), null);
});

test("a step that was already used cannot be replayed", () => {
  const now = 1_700_000_000_000;
  const code = totp.totpCode(RFC_SECRET, now);
  const step = totp.verifyTotp(RFC_SECRET, code, { nowMs: now })!;
  assert.equal(totp.verifyTotp(RFC_SECRET, code, { nowMs: now, lastUsedStep: step }), null);
  // The next step's code is still fine.
  const next = totp.totpCode(RFC_SECRET, now + 30_000);
  assert.equal(
    totp.verifyTotp(RFC_SECRET, next, { nowMs: now + 30_000, lastUsedStep: step }),
    step + 1
  );
});

test("malformed codes and secrets are refused, never thrown", () => {
  for (const bad of [
    "",
    "12345",
    "1234567",
    "abcdef",
    "12 34 5",
    null as never,
    undefined as never,
  ]) {
    assert.equal(totp.verifyTotp(RFC_SECRET, bad, { nowMs: 1 }), null);
  }
  assert.equal(totp.verifyTotp("not*base32", "123456"), null);
});

test("the otpauth URI carries the parameters authenticator apps read", () => {
  const uri = totp.otpauthUri({ issuer: "Red Router", account: "owner@x.io", secret: "ABCD" });
  assert.match(uri, /^otpauth:\/\/totp\/Red%20Router:owner%40x\.io\?/);
  const params = new URL(uri).searchParams;
  assert.equal(params.get("secret"), "ABCD");
  assert.equal(params.get("digits"), "6");
  assert.equal(params.get("period"), "30");
  assert.equal(params.get("algorithm"), "SHA1");
});

test("recovery codes are distinct, well formed and hashed case/format-insensitively", () => {
  const codes = totp.generateRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const code of codes) assert.match(code, /^[a-z2-7]{5}-[a-z2-7]{5}$/);
  const [first] = codes;
  assert.equal(
    totp.hashRecoveryCode(first),
    totp.hashRecoveryCode(first.toUpperCase().replace("-", " "))
  );
  assert.notEqual(totp.hashRecoveryCode(first), totp.hashRecoveryCode(codes[1]));
  assert.match(totp.hashRecoveryCode(first), /^[0-9a-f]{64}$/);
});
