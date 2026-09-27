import { z } from "zod";

import { WINDSURF_CONFIG } from "../constants/oauth";

const MAX_REGISTER_RESPONSE_BYTES = 64 * 1024;
const RegisterUserSchema = z
  .object({
    apiKey: z.string().min(1).optional(),
    api_key: z.string().min(1).optional(),
    name: z.string().optional(),
  })
  .refine((value) => Boolean(value.apiKey || value.api_key));

async function readBoundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Windsurf RegisterUser returned an empty body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REGISTER_RESPONSE_BYTES) {
        await reader.cancel("Windsurf RegisterUser response exceeded limit");
        throw new Error("Windsurf RegisterUser response exceeded limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new Error("Windsurf RegisterUser returned invalid JSON");
  }
}

export const windsurf = {
  config: WINDSURF_CONFIG,
  flowType: "authorization_code" as const,
  callbackPath: WINDSURF_CONFIG.callbackPath,
  callbackHost: "127.0.0.1",

  buildAuthUrl(config: typeof WINDSURF_CONFIG, redirectUri: string, state: string): string {
    const params = new URLSearchParams({
      response_type: "token",
      client_id: config.clientId,
      redirect_uri: redirectUri,
      state,
      prompt: "login",
      redirect_parameters_type: "query",
      workflow: "onboarding",
    });
    return `${config.authBaseUrl}${config.signInPath}?${params}`;
  },

  async exchangeToken(
    config: typeof WINDSURF_CONFIG,
    code: string
  ): Promise<{ accessToken: string; authMethod: "oauth" | "imported"; name?: string }> {
    const token = String(code ?? "")
      .trim()
      .replace(/^Bearer\s+/i, "");
    if (token.startsWith("sk-ws-")) {
      return { accessToken: token, authMethod: "imported" };
    }
    if (
      !/^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) ||
      token.length > 16 * 1024
    ) {
      throw new Error("Windsurf Firebase ID token is invalid");
    }
    const response = await fetch(config.registerUrl, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ firebase_id_token: token }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new Error(`Windsurf RegisterUser returned HTTP ${response.status}`);
    }
    const data = RegisterUserSchema.safeParse(await readBoundedJson(response));
    if (!data.success) throw new Error("Windsurf RegisterUser omitted the API key");
    return {
      accessToken: (data.data.apiKey || data.data.api_key) as string,
      authMethod: "oauth",
      ...(data.data.name ? { name: data.data.name } : {}),
    };
  },

  mapTokens(tokens: { accessToken: string; authMethod?: "oauth" | "imported"; name?: string }) {
    return {
      accessToken: tokens.accessToken,
      refreshToken: null,
      expiresIn: null,
      displayName: tokens.name,
      providerSpecificData: { authMethod: tokens.authMethod ?? "imported" },
    };
  },
};
