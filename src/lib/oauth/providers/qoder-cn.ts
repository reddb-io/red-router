import { createHash, randomBytes, randomUUID } from "node:crypto";

import { z } from "zod";

import { QODER_CN_CONFIG } from "../constants/oauth";

const QODER_CN_LOGIN_URL = QODER_CN_CONFIG.loginUrl;
const QODER_CN_DEVICE_TOKEN_URL = QODER_CN_CONFIG.deviceTokenUrl;
const QODER_CN_USERINFO_URL = QODER_CN_CONFIG.userInfoUrl;
const MAX_RESPONSE_BYTES = 64 * 1024;

const DeviceTokenSchema = z.object({
  token: z
    .string()
    .startsWith("dt-")
    .max(16 * 1024),
  user_id: z.string().max(256).optional(),
  expires_at: z.union([z.string().max(128), z.number()]).optional(),
  expires_in: z.number().nonnegative().optional(),
});

const UuidSchema = z.uuid();
const PollInputSchema = z.object({
  nonce: UuidSchema,
  verifier: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  machineId: UuidSchema.optional(),
});

const UserInfoSchema = z.object({
  id: z.string().max(256).optional(),
  userId: z.string().max(256).optional(),
  name: z.string().max(256).optional(),
  username: z.string().max(256).optional(),
  email: z.string().max(320).optional(),
});

type QoderCnTokenData = {
  access_token: string;
  expires_in: number;
  _qoderUserId: string;
  _qoderMachineId: string;
  _qoderEmail: string;
  _qoderName: string;
};

type QoderCnPollResult =
  { ok: true; data: QoderCnTokenData } | { ok: false; data: { error: string } };

async function readBoundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Qoder CN returned an empty response");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel("Qoder CN response exceeded limit");
        throw new Error("Qoder CN response exceeded limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new Error("Qoder CN returned invalid JSON");
  }
}

function expiresInSeconds(expiresAt: string | number | undefined, expiresIn?: number): number {
  let expiresMs: number | undefined;
  if (typeof expiresAt === "number") expiresMs = expiresAt;
  else if (typeof expiresAt === "string" && /^\d+$/.test(expiresAt.trim())) {
    expiresMs = Number(expiresAt.trim());
  } else if (typeof expiresAt === "string") expiresMs = Date.parse(expiresAt);

  const seconds = Number.isFinite(expiresMs)
    ? Math.floor(((expiresMs as number) - Date.now()) / 1000)
    : (expiresIn ?? 30 * 24 * 60 * 60);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error("Qoder CN device token is already expired");
  }
  return seconds;
}

async function fetchUserInfo(token: string) {
  try {
    const response = await fetch(QODER_CN_USERINFO_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      return null;
    }
    const parsed = UserInfoSchema.safeParse(await readBoundedJson(response));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const qoderCn = {
  flowType: "device_code" as const,
  config: QODER_CN_CONFIG,

  requestDeviceCode() {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const nonce = randomUUID();
    const machineId = randomUUID();
    const url = new URL(QODER_CN_LOGIN_URL);
    url.search = new URLSearchParams({
      challenge,
      challenge_method: "S256",
      machine_id: machineId,
      nonce,
    }).toString();
    return {
      device_code: nonce,
      user_code: nonce.slice(0, 8).toUpperCase(),
      verification_uri: QODER_CN_LOGIN_URL,
      verification_uri_complete: url.toString(),
      expires_in: 300,
      interval: 2,
      codeVerifier: verifier,
      _qoderMachineId: machineId,
    };
  },

  async pollToken(
    _config: unknown,
    nonce: string,
    verifier: string,
    extraData?: { _qoderMachineId?: string }
  ): Promise<QoderCnPollResult> {
    const input = PollInputSchema.safeParse({
      nonce,
      verifier,
      machineId: extraData?._qoderMachineId || undefined,
    });
    if (!input.success) {
      return { ok: false, data: { error: "invalid_request" } };
    }
    const url = new URL(QODER_CN_DEVICE_TOKEN_URL);
    url.search = new URLSearchParams({
      nonce: input.data.nonce,
      verifier: input.data.verifier,
      challenge_method: "S256",
    }).toString();
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": "Go-http-client/2.0" },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 202 || response.status === 404) {
      void response.body?.cancel().catch(() => {});
      return { ok: false, data: { error: "authorization_pending" } };
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      return { ok: false, data: { error: "device_token_failed" } };
    }
    const parsed = DeviceTokenSchema.safeParse(await readBoundedJson(response));
    if (!parsed.success) return { ok: false, data: { error: "invalid_response" } };

    const token = parsed.data;
    const userInfo = await fetchUserInfo(token.token);
    const userId = token.user_id || userInfo?.id || userInfo?.userId;
    if (!userId) return { ok: false, data: { error: "missing_user_id" } };

    return {
      ok: true,
      data: {
        access_token: token.token,
        expires_in: expiresInSeconds(token.expires_at, token.expires_in),
        _qoderUserId: userId,
        _qoderMachineId: input.data.machineId || "",
        _qoderEmail: userInfo?.email || "",
        _qoderName: userInfo?.name || userInfo?.username || "",
      },
    };
  },

  mapTokens(tokens: QoderCnTokenData) {
    return {
      accessToken: tokens.access_token,
      refreshToken: null,
      expiresIn: tokens.expires_in,
      email: tokens._qoderEmail || `qoder-cn-user-${tokens._qoderUserId}`,
      displayName: tokens._qoderName || null,
      providerSpecificData: {
        authMethod: "device",
        userId: tokens._qoderUserId,
        machineId: tokens._qoderMachineId,
        region: "cn",
      },
    };
  },
};
