import { z } from "zod";

import { IFLOW_CONFIG } from "../constants/oauth";

const MAX_RESPONSE_BYTES = 64 * 1024;
const TokenSchema = z.object({
  access_token: z
    .string()
    .min(1)
    .max(16 * 1024),
  refresh_token: z
    .string()
    .max(16 * 1024)
    .optional(),
  expires_in: z.coerce
    .number()
    .int()
    .positive()
    .max(365 * 24 * 60 * 60)
    .optional(),
});
const UserInfoSchema = z.object({
  success: z.literal(true),
  data: z.object({
    apiKey: z
      .string()
      .trim()
      .min(1)
      .max(16 * 1024),
    email: z.string().trim().optional(),
    phone: z.string().trim().optional(),
    nickname: z.string().trim().optional(),
    name: z.string().trim().optional(),
  }),
});

type Tokens = z.infer<typeof TokenSchema>;
type UserInfo = z.infer<typeof UserInfoSchema>["data"];

async function readBoundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("iFlow returned an empty response");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel("iFlow response exceeded limit");
        throw new Error("iFlow response exceeded limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new Error("iFlow returned invalid JSON");
  }
}

export const iflow = {
  config: IFLOW_CONFIG,
  flowType: "authorization_code" as const,

  buildAuthUrl(config: typeof IFLOW_CONFIG, redirectUri: string, state: string): string {
    const url = new URL(config.authorizeUrl);
    url.searchParams.set("loginMethod", config.extraParams.loginMethod);
    url.searchParams.set("type", config.extraParams.type);
    url.searchParams.set("redirect", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("client_id", config.clientId);
    return url.toString();
  },

  async exchangeToken(
    config: typeof IFLOW_CONFIG,
    code: string,
    redirectUri: string
  ): Promise<Tokens> {
    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new Error(`iFlow token exchange failed (${response.status})`);
    }
    const parsed = TokenSchema.safeParse(await readBoundedJson(response));
    if (!parsed.success) throw new Error("iFlow returned an invalid token response");
    return parsed.data;
  },

  async postExchange(tokens: Tokens): Promise<{ userInfo: UserInfo }> {
    const url = new URL(IFLOW_CONFIG.userInfoUrl);
    url.searchParams.set("accessToken", tokens.access_token);
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new Error(`iFlow user info failed (${response.status})`);
    }
    const parsed = UserInfoSchema.safeParse(await readBoundedJson(response));
    if (!parsed.success) throw new Error("iFlow returned invalid user info");
    const userInfo = parsed.data.data;
    if (!userInfo.email && !userInfo.phone) {
      throw new Error("iFlow user info has no account identity");
    }
    return { userInfo };
  },

  mapTokens(tokens: Tokens, extra?: { userInfo: UserInfo }) {
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || null,
      expiresIn: tokens.expires_in || null,
      apiKey: extra?.userInfo.apiKey,
      email: extra?.userInfo.email || extra?.userInfo.phone,
      displayName: extra?.userInfo.nickname || extra?.userInfo.name,
    };
  },
};
