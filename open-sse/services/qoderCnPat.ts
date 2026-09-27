import { createHash } from "node:crypto";

import { z } from "zod";

import { QoderCnHttpError } from "./qoderCnHttpError.ts";

const EXCHANGE_URL = "https://openapi.qoder.com.cn/api/v1/jobToken/exchange";
const USERINFO_URL = "https://openapi.qoder.com.cn/api/v1/userinfo";
const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TTL_MS = 23 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 128;

const ExchangeSchema = z.object({
  token: z
    .string()
    .startsWith("jt-")
    .max(16 * 1024),
  expires_in: z.number().finite().positive().optional(),
});
const UserInfoSchema = z.object({
  id: z.string().min(1).max(256).optional(),
  userId: z.string().min(1).max(256).optional(),
  user_id: z.string().min(1).max(256).optional(),
});

export type QoderCnPatCredential = {
  accessToken: string;
  userId: string;
  expiresAt: number;
};

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
type ResolveOptions = { fetchImpl?: FetchLike; signal?: AbortSignal; now?: number };

const cache = new Map<string, QoderCnPatCredential>();
const pending = new Map<string, Promise<QoderCnPatCredential>>();

async function readBoundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Qoder CN returned an empty response");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel("Qoder CN response exceeded limit");
        throw new Error("Qoder CN response exceeded limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new Error("Qoder CN returned invalid JSON");
  }
}

async function exchangePat(pat: string, fetchImpl: FetchLike): Promise<QoderCnPatCredential> {
  const response = await fetchImpl(EXCHANGE_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "qodercli/1.0.0",
      "Cosy-Version": "1.0.0",
      "Cosy-ClientType": "5",
    },
    body: JSON.stringify({ personal_token: pat }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new QoderCnHttpError("PAT exchange", response.status);
  }
  const exchanged = ExchangeSchema.safeParse(await readBoundedJson(response));
  if (!exchanged.success) throw new Error("Qoder CN PAT exchange omitted a job token");

  const profileResponse = await fetchImpl(USERINFO_URL, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${exchanged.data.token}`,
      "User-Agent": "qodercli/1.0.0",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!profileResponse.ok) {
    void profileResponse.body?.cancel().catch(() => {});
    throw new QoderCnHttpError("job-token userinfo", profileResponse.status);
  }
  const profile = UserInfoSchema.safeParse(await readBoundedJson(profileResponse));
  const userId = profile.success
    ? profile.data.id || profile.data.userId || profile.data.user_id
    : undefined;
  if (!userId) throw new Error("Qoder CN job token has no user ID");

  const ttlMs = exchanged.data.expires_in
    ? Math.min(exchanged.data.expires_in * 1000, DEFAULT_TTL_MS)
    : DEFAULT_TTL_MS;
  const cacheTtl = ttlMs - Math.min(5 * 60 * 1000, ttlMs / 10);
  return { accessToken: exchanged.data.token, userId, expiresAt: Date.now() + cacheTtl };
}

function waitForCaller<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new Error("Aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

/** Exchange a CN PAT once per credential; never send the raw PAT to COSY. */
export async function resolveQoderCnPat(
  pat: string,
  options: ResolveOptions = {}
): Promise<QoderCnPatCredential> {
  if (!pat.startsWith("pt-") || pat.length > 16 * 1024 || !/^[\x21-\x7e]+$/.test(pat)) {
    throw new Error("Qoder CN PAT is invalid");
  }
  if (options.signal?.aborted) {
    throw options.signal.reason ?? new Error("Aborted");
  }

  const key = createHash("sha256").update(pat).digest("hex");
  const now = options.now ?? Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached;

  let inFlight = pending.get(key);
  if (!inFlight) {
    const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    inFlight = exchangePat(pat, fetchImpl)
      .then((resolved) => {
        for (const [candidate, value] of cache) {
          if (value.expiresAt <= Date.now()) cache.delete(candidate);
        }
        if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
        cache.set(key, resolved);
        return resolved;
      })
      .finally(() => {
        pending.delete(key);
      });
    pending.set(key, inFlight);
  }
  return waitForCaller(inFlight, options.signal);
}

export function clearQoderCnPatCacheForTest(): void {
  cache.clear();
  pending.clear();
}
