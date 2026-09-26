const STANDARD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const QODER_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const SUBSTITUTION = new Uint8Array(128);

for (let index = 0; index < STANDARD_ALPHABET.length; index++) {
  SUBSTITUTION[STANDARD_ALPHABET.charCodeAt(index)] = QODER_ALPHABET.charCodeAt(index);
}
SUBSTITUTION["=".charCodeAt(0)] = "$".charCodeAt(0);

/** Qoder's Encode=1 body transform. Return bytes so COSY signs the exact wire body. */
export function encodeQoderCnBody(plaintext: Uint8Array): Uint8Array {
  if (plaintext.byteLength > 6 * 1024 * 1024) {
    throw new Error("Qoder CN request body exceeds the size limit");
  }
  const base64 = Buffer.from(plaintext).toString("base64");
  const third = Math.floor(base64.length / 3);
  const reordered =
    base64.slice(base64.length - third) +
    base64.slice(third, base64.length - third) +
    base64.slice(0, third);
  const encoded = new Uint8Array(reordered.length);
  for (let index = 0; index < reordered.length; index++) {
    encoded[index] = SUBSTITUTION[reordered.charCodeAt(index)];
  }
  return encoded;
}
