import { constants, createCipheriv, createHash, publicEncrypt, randomUUID } from "node:crypto";

import { z } from "zod";

// Qoder IDE's public wrapping key, also present in the upstream qodercli adapter.
const QODER_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

const CnCredentialSchema = z.object({
  userId: z.string().min(1).max(256),
  authToken: z
    .string()
    .regex(/^(dt|jt)-[\x21-\x7e]+$/)
    .max(16 * 1024),
  machineId: z.uuid().optional(),
  name: z.string().max(256).optional(),
  email: z.string().max(320).optional(),
});

export type QoderCnCosyCredential = z.infer<typeof CnCredentialSchema>;

const SIGNED_PATHS = new Set([
  "/algo/api/v2/model/list",
  "/algo/api/v2/image/upload",
  "/algo/api/v2/service/pro/sse/agent_chat_generation",
]);

/** Sign the exact outbound bytes for the CN gateway; never sign a global/foreign host. */
export function buildQoderCnCosyHeaders(
  body: Uint8Array,
  requestUrl: string,
  credentials: QoderCnCosyCredential
): Record<string, string> {
  const creds = CnCredentialSchema.parse(credentials);
  const url = new URL(requestUrl);
  if (
    url.protocol !== "https:" ||
    url.host !== "gateway.qoder.com.cn" ||
    !SIGNED_PATHS.has(url.pathname) ||
    body.byteLength >
      (url.pathname === "/algo/api/v2/image/upload" ? 11 * 1024 * 1024 : 8 * 1024 * 1024)
  ) {
    throw new Error("Qoder CN COSY signing target is invalid");
  }

  const bodyBytes = Buffer.from(body);
  const aesKey = Buffer.from(randomUUID().slice(0, 16), "utf8");
  const userInfo = JSON.stringify({
    uid: creds.userId,
    security_oauth_token: creds.authToken,
    name: creds.name || "",
    aid: "",
    email: creds.email || "",
  });
  const cipher = createCipheriv("aes-128-cbc", aesKey, aesKey);
  const encryptedInfo = Buffer.concat([cipher.update(userInfo, "utf8"), cipher.final()]).toString(
    "base64"
  );
  const wrappedKey = publicEncrypt(
    { key: QODER_RSA_PUBLIC_KEY, padding: constants.RSA_PKCS1_PADDING },
    aesKey
  ).toString("base64");

  const timestamp = String(Math.floor(Date.now() / 1000));
  const payload = Buffer.from(
    JSON.stringify({
      version: "v1",
      requestId: randomUUID(),
      info: encryptedInfo,
      cosyVersion: "1.0.0",
      ideVersion: "",
    }),
    "utf8"
  ).toString("base64");
  const sigPath = url.pathname.slice("/algo".length);
  const signatureBytes = Buffer.concat([
    Buffer.from(`${payload}\n${wrappedKey}\n${timestamp}\n`, "utf8"),
    bodyBytes,
    Buffer.from(`\n${sigPath}`, "utf8"),
  ]);
  const signature = createHash("md5").update(signatureBytes).digest("hex");
  const machineId = creds.machineId || randomUUID();

  return {
    Authorization: `Bearer COSY.${payload}.${signature}`,
    "Cosy-Key": wrappedKey,
    "Cosy-User": creds.userId,
    "Cosy-Date": timestamp,
    "Cosy-Version": "1.0.0",
    "Cosy-Machineid": machineId,
    "Cosy-Machinetoken": machineId,
    "Cosy-Machinetype": "5",
    "Cosy-Machineos": "x86_64_windows",
    "Cosy-Clienttype": "5",
    "Cosy-Clientip": "127.0.0.1",
    "Cosy-Bodyhash": createHash("md5").update(bodyBytes).digest("hex"),
    "Cosy-Bodylength": String(bodyBytes.byteLength),
    "Cosy-Sigpath": sigPath,
    "Cosy-Data-Policy": "disagree",
    "Cosy-Organization-Id": "",
    "Cosy-Organization-Tags": "",
    "Login-Version": "v2",
    "X-Request-Id": randomUUID(),
  };
}
