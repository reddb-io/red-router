import { z } from "zod";

import { CODEBUDDY_INTL_CONFIG } from "../constants/oauth";

const MAX_RESPONSE_BYTES = 64 * 1024;
const DeviceStateSchema = z.object({
  code: z.number(),
  data: z
    .object({
      state: z.string().min(1).max(1024),
      authUrl: z.url().max(4096),
    })
    .optional(),
});
const TokenResponseSchema = z.object({
  code: z.number(),
  data: z
    .object({
      accessToken: z
        .string()
        .min(1)
        .max(16 * 1024),
      refreshToken: z
        .string()
        .max(16 * 1024)
        .optional(),
      tokenType: z.string().max(64).optional(),
      expiresIn: z
        .number()
        .positive()
        .max(365 * 24 * 60 * 60)
        .optional(),
    })
    .optional(),
});

type Config = typeof CODEBUDDY_INTL_CONFIG;
type Tokens = {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
};

async function readBoundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("CodeBuddy Intl returned an empty response");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel("CodeBuddy Intl response exceeded limit");
        throw new Error("CodeBuddy Intl response exceeded limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new Error("CodeBuddy Intl returned invalid JSON");
  }
}

function isTrustedAuthUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      (url.hostname === "codebuddy.ai" || url.hostname.endsWith(".codebuddy.ai"))
    );
  } catch {
    return false;
  }
}

export const codebuddyIntl = {
  config: CODEBUDDY_INTL_CONFIG,
  flowType: "device_code" as const,

  async requestDeviceCode(config: Config) {
    const stateUrl = new URL(config.stateUrl);
    stateUrl.searchParams.set("platform", config.platform);
    const response = await fetch(stateUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": config.userAgent,
        "X-Requested-With": "XMLHttpRequest",
        "X-Domain": "www.codebuddy.ai",
        "X-No-Authorization": "true",
        "X-No-User-Id": "true",
        "X-Product": "SaaS",
      },
      body: "{}",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new Error(`CodeBuddy Intl state request failed (${response.status})`);
    }
    const parsed = DeviceStateSchema.safeParse(await readBoundedJson(response));
    if (!parsed.success || parsed.data.code !== 0 || !parsed.data.data) {
      throw new Error("CodeBuddy Intl returned an invalid device state");
    }
    if (!isTrustedAuthUrl(parsed.data.data.authUrl)) {
      throw new Error("CodeBuddy Intl returned an untrusted authorization URL");
    }
    return {
      device_code: parsed.data.data.state,
      user_code: "",
      verification_uri: parsed.data.data.authUrl,
      verification_uri_complete: parsed.data.data.authUrl,
      expires_in: 600,
      interval: Math.max(1, Math.floor(config.pollInterval / 1000)),
    };
  },

  async pollToken(config: Config, deviceCode: string) {
    if (!z.string().min(1).max(1024).safeParse(deviceCode).success) {
      return { ok: false, data: { error: "invalid_device_code" } };
    }
    const tokenUrl = new URL(config.tokenUrl);
    tokenUrl.searchParams.set("state", deviceCode);
    const response = await fetch(tokenUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": config.userAgent,
        "X-Requested-With": "XMLHttpRequest",
        "X-Domain": "www.codebuddy.ai",
        "X-No-Authorization": "true",
        "X-No-User-Id": "true",
        "X-No-Enterprise-Id": "true",
        "X-No-Department-Info": "true",
        "X-Product": "SaaS",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      return { ok: false, data: { error: "request_failed" } };
    }
    const parsed = TokenResponseSchema.safeParse(await readBoundedJson(response));
    if (!parsed.success) return { ok: false, data: { error: "invalid_response" } };
    if (parsed.data.code === 11217) {
      return { ok: true, data: { error: "authorization_pending" } };
    }
    if (parsed.data.code !== 0 || !parsed.data.data) {
      return { ok: false, data: { error: "authorization_failed" } };
    }
    return {
      ok: true,
      data: {
        access_token: parsed.data.data.accessToken,
        refresh_token: parsed.data.data.refreshToken || "",
        token_type: parsed.data.data.tokenType || "Bearer",
        expires_in: parsed.data.data.expiresIn,
      },
    };
  },

  mapTokens(tokens: Tokens) {
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || "",
      expiresIn: tokens.expires_in || 86400,
      providerSpecificData: {},
    };
  },
};

export default codebuddyIntl;
