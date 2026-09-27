import { resolveQoderCnPat } from "./qoderCnPat.ts";

const QUOTA_URL = "https://openapi.qoder.com.cn/api/v2/quota/usage";
const MAX_RESPONSE_BYTES = 64 * 1024;
type JsonRecord = Record<string, unknown>;
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type QoderCnQuotaRow = {
  total: number;
  used: number;
  remaining: number;
  remainingPercentage: number;
  unit: string;
  resetAt: string | null;
  unlimited: boolean;
};

export type QoderCnUsage = {
  quotas: Record<string, QoderCnQuotaRow>;
  totalUsagePercentage?: number;
  isQuotaExceeded: boolean;
  expiresAt: number | null;
};

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function nonnegative(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

/** Parse the documented CN quota fields without turning missing values into zero balance. */
export function parseQoderCnQuota(raw: unknown): QoderCnUsage | null {
  const body = record(raw);
  if (!body) return null;
  const expiresAt = nonnegative(body.expiresAt);
  const resetAt =
    expiresAt && expiresAt > 0 && expiresAt <= 8.64e15 ? new Date(expiresAt).toISOString() : null;
  const isQuotaExceeded = body.isQuotaExceeded === true;
  const quotas: Record<string, QoderCnQuotaRow> = {};
  for (const [name, key] of [
    ["user", "userQuota"],
    ["organization", "orgResourcePackage"],
  ] as const) {
    const source = record(body[key]);
    if (!source) continue;
    const total = nonnegative(source.total);
    const used = nonnegative(source.used);
    const remaining = nonnegative(source.remaining);
    if (total === null || used === null || remaining === null) continue;
    if (total === 0 && typeof body.isQuotaExceeded !== "boolean") continue;
    quotas[name] = {
      total,
      used,
      remaining,
      remainingPercentage: isQuotaExceeded
        ? 0
        : total > 0
          ? Math.max(0, Math.min(100, (remaining / total) * 100))
          : 100,
      unit: typeof source.unit === "string" && source.unit.length <= 64 ? source.unit : "credits",
      resetAt,
      unlimited: total === 0 && !isQuotaExceeded,
    };
  }
  if (Object.keys(quotas).length === 0) return null;
  const totalUsagePercentage = nonnegative(body.totalUsagePercentage);
  return {
    quotas,
    ...(totalUsagePercentage !== null
      ? { totalUsagePercentage: Math.min(100, totalUsagePercentage) }
      : {}),
    isQuotaExceeded,
    expiresAt,
  };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Qoder CN quota response is empty");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel("Qoder CN quota response exceeded limit");
        throw new Error("Qoder CN quota response exceeded limit");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}

/** Candidate CN usage fetcher; no global Qoder/DashScope quota fallback. */
export async function getQoderCnUsage(
  token: string,
  options: { fetchImpl?: FetchLike; signal?: AbortSignal } = {}
): Promise<QoderCnUsage | { message: string }> {
  if (!token || token.length > 16 * 1024) {
    return { message: "Qoder CN usage unavailable: credentials are missing" };
  }
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  let authToken = token.trim();
  try {
    if (authToken.startsWith("pt-")) {
      authToken = (await resolveQoderCnPat(authToken, { fetchImpl, signal: options.signal }))
        .accessToken;
    }
    if (!/^(dt|jt)-[\x21-\x7e]+$/.test(authToken)) {
      return { message: "Qoder CN usage unavailable: invalid credential type" };
    }
    const timeout = AbortSignal.timeout(15_000);
    const response = await fetchImpl(QUOTA_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${authToken}`, Accept: "application/json" },
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      return { message: `Qoder CN usage API returned HTTP ${response.status}` };
    }
    const parsed = parseQoderCnQuota(await readBoundedJson(response));
    return parsed || { message: "Qoder CN usage response has no usable quota records" };
  } catch {
    return { message: "Qoder CN usage request failed" };
  }
}
