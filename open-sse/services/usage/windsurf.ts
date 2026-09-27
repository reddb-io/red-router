/** Candidate Windsurf quota path through Codeium's API-key GetUserStatus RPC. */
import { parseDevinUserStatus } from "./devinCli.ts";
import { parseResetTime, type UsageQuota } from "./quota.ts";

const STATUS_URL =
  "https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus";
const MAX_RESPONSE_BYTES = 256 * 1024;
const encoder = new TextEncoder();

function varint(value: number): number[] {
  const bytes: number[] = [];
  do {
    const byte = value & 0x7f;
    value = Math.floor(value / 128);
    bytes.push(value ? byte | 0x80 : byte);
  } while (value);
  return bytes;
}

function stringField(number: number, value: string): number[] {
  const bytes = encoder.encode(value);
  return [...varint((number << 3) | 2), ...varint(bytes.length), ...bytes];
}

/** GetUserStatusRequest.metadata with the credential in the API-key field. */
export function buildWindsurfUserStatusRequest(apiKey: string): Uint8Array {
  const metadata = [
    ...stringField(1, "windsurf"),
    ...stringField(2, "3.14.0"),
    ...stringField(3, apiKey),
    ...stringField(4, "en"),
    ...stringField(5, "linux"),
    ...stringField(7, "3.14.0"),
  ];
  return Uint8Array.from([...varint((1 << 3) | 2), ...varint(metadata.length), ...metadata]);
}

async function readBounded(response: Response): Promise<Uint8Array | null> {
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
        await reader.cancel("Windsurf quota response exceeded limit");
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function percentQuota(remaining: number, resetAt: number | null, displayName: string): UsageQuota {
  const safeRemaining = Math.min(Math.max(remaining, 0), 100);
  return {
    used: 100 - safeRemaining,
    total: 100,
    remaining: safeRemaining,
    remainingPercentage: safeRemaining,
    resetAt: parseResetTime(resetAt),
    unlimited: false,
    displayName,
  };
}

export async function getWindsurfUsage(apiKey: string | null | undefined) {
  if (!apiKey?.trim()) return { message: "Windsurf API key not available." };
  const key = apiKey.trim();
  let response: Response;
  try {
    response = await fetch(STATUS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/proto",
        "Connect-Protocol-Version": "1",
        Authorization: `Basic ${key}-${key}`,
      },
      body: Uint8Array.from(buildWindsurfUserStatusRequest(key)).buffer,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { message: "Windsurf quota request failed." };
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    return { message: `Windsurf quota endpoint returned HTTP ${response.status}.` };
  }
  let payload: Uint8Array | null;
  try {
    payload = await readBounded(response);
  } catch {
    return { message: "Windsurf quota response could not be read." };
  }
  if (!payload) return { message: "Windsurf quota response exceeded the size limit." };
  const snapshot = parseDevinUserStatus(payload);
  if (!snapshot) return { message: "Windsurf quota response format is not recognized." };
  const quotas: Record<string, UsageQuota> = {};
  if (snapshot.dailyRemainingPercent !== null) {
    quotas.daily = percentQuota(
      snapshot.dailyRemainingPercent,
      snapshot.dailyResetAtUnix,
      "Daily Quota"
    );
  }
  if (snapshot.weeklyRemainingPercent !== null) {
    quotas.weekly = percentQuota(
      snapshot.weeklyRemainingPercent,
      snapshot.weeklyResetAtUnix,
      "Weekly Quota"
    );
  }
  if (Object.keys(quotas).length === 0) {
    return { message: "Windsurf quota fields are absent from the response." };
  }
  return { plan: snapshot.plan ?? "Windsurf", quotas };
}
