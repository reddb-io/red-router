import { z } from "zod";

import { runWithProxyContext } from "../../../utils/proxyFetch.ts";
import type { RefreshLogger } from "../shared.ts";

const MAX_RESPONSE_BYTES = 64 * 1024;
const RefreshResponseSchema = z.object({
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
      expiresIn: z
        .number()
        .positive()
        .max(365 * 24 * 60 * 60)
        .optional(),
    })
    .optional(),
});

async function readBoundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel("CodeBuddy Intl refresh response exceeded limit");
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    return null;
  }
}

/** Refresh the .ai device session without ever sending its token to the CN host. */
export async function refreshCodebuddyIntlToken(
  refreshToken: string,
  log: RefreshLogger,
  proxyConfig: unknown = null
) {
  if (!refreshToken) return null;
  const { CODEBUDDY_INTL_CONFIG } = await import("@/lib/oauth/constants/oauth");
  try {
    const response = await runWithProxyContext(proxyConfig, () =>
      fetch(CODEBUDDY_INTL_CONFIG.refreshUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": CODEBUDDY_INTL_CONFIG.userAgent,
          "X-Requested-With": "XMLHttpRequest",
          "X-Domain": "www.codebuddy.ai",
          "X-Refresh-Token": refreshToken,
          "X-Auth-Refresh-Source": "plugin",
          "X-Product": "SaaS",
        },
        body: "{}",
        signal: AbortSignal.timeout(15_000),
      })
    );
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      log?.warn?.("TOKEN_REFRESH", "CodeBuddy Intl token refresh was rejected", {
        status: response.status,
      });
      return null;
    }
    const parsed = RefreshResponseSchema.safeParse(await readBoundedJson(response));
    if (!parsed.success || parsed.data.code !== 0 || !parsed.data.data) {
      log?.warn?.("TOKEN_REFRESH", "CodeBuddy Intl token refresh returned no valid token");
      return null;
    }
    return {
      accessToken: parsed.data.data.accessToken,
      refreshToken: parsed.data.data.refreshToken || refreshToken,
      expiresIn: parsed.data.data.expiresIn,
    };
  } catch {
    log?.warn?.("TOKEN_REFRESH", "CodeBuddy Intl token refresh transport unavailable");
    return null;
  }
}
