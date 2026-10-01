import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { pipeline } from "node:stream/promises";

// Keep the v1 wire format so backups created by previous releases remain readable.
export async function encryptFile(source, destination, passphrase) {
  if (!passphrase) throw new Error("Backup passphrase must not be empty");
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", scryptSync(passphrase, salt, 32), iv);
  const temporary = `${destination}.ciphertext`;
  try {
    await pipeline(createReadStream(source), cipher, createWriteStream(temporary, { mode: 0o600 }));
    await fs.writeFile(destination, Buffer.concat([salt, iv, cipher.getAuthTag()]), {
      mode: 0o600,
    });
    await pipeline(createReadStream(temporary), createWriteStream(destination, { flags: "a" }));
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function decryptFile(source, destination, passphrase) {
  if (!passphrase) throw new Error("Backup passphrase must not be empty");
  const handle = await fs.open(source, "r");
  const header = Buffer.alloc(44);
  try {
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead !== header.length) throw new Error("Invalid encrypted backup file");
  } finally {
    await handle.close();
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    scryptSync(passphrase, header.subarray(0, 16), 32),
    header.subarray(16, 28)
  );
  decipher.setAuthTag(header.subarray(28, 44));
  try {
    await pipeline(
      createReadStream(source, { start: 44 }),
      decipher,
      createWriteStream(destination, { mode: 0o600, flags: "wx" })
    );
  } catch {
    await fs.rm(destination, { force: true });
    throw new Error("Backup authentication failed: wrong passphrase or damaged file");
  }
}
