import assert from "node:assert/strict";
import test from "node:test";

import { encodeQoderCnBody } from "../../open-sse/services/qoderCnEncoding.ts";

const STANDARD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
const QODER_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!$";

function decodeQoderBody(encoded: Uint8Array): Uint8Array {
  const substituted = [...encoded]
    .map((value) => STANDARD_ALPHABET[QODER_ALPHABET.indexOf(String.fromCharCode(value))])
    .join("");
  const third = Math.floor(substituted.length / 3);
  const head = substituted.slice(substituted.length - third);
  const tail = substituted.slice(0, third);
  const middle = substituted.slice(third, substituted.length - third);
  return Buffer.from(head + middle + tail, "base64");
}

test("Qoder CN Encode=1 preserves arbitrary UTF-8 bytes through the wire transform", () => {
  for (const value of ["", "abc", "hello", "ação 🚀", "a".repeat(128)]) {
    const input = new TextEncoder().encode(value);
    const encoded = encodeQoderCnBody(input);
    assert.deepEqual(decodeQoderBody(encoded), Buffer.from(input));
    assert.equal(encoded.length, Buffer.from(input).toString("base64").length);
  }
});

test("Qoder CN encoded body contains only the provider alphabet", () => {
  const encoded = encodeQoderCnBody(new TextEncoder().encode("hello world 0123456789"));
  for (const value of encoded) {
    assert.ok(QODER_ALPHABET.includes(String.fromCharCode(value)));
  }
});

test("Qoder CN rejects plaintext that would exceed the request boundary", () => {
  assert.throws(() => encodeQoderCnBody(new Uint8Array(6 * 1024 * 1024 + 1)), /size limit/);
});
