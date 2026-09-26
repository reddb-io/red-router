import { createHmac, randomUUID } from "node:crypto";

export const IFLOW_USER_AGENT = "iFlow-Cli";

export function createIFlowSignature(
  userAgent: string,
  sessionId: string,
  timestamp: number,
  credential: string
): string {
  if (!credential) return "";
  return createHmac("sha256", credential)
    .update(`${userAgent}:${sessionId}:${timestamp}`)
    .digest("hex");
}

/** Per-request headers required by both chat dispatch and credential probing. */
export function buildIFlowSignedHeaders(
  credential: string,
  userAgent = IFLOW_USER_AGENT
): Record<string, string> {
  const sessionId = `session-${randomUUID()}`;
  const timestamp = Date.now();
  return {
    "session-id": sessionId,
    "x-iflow-timestamp": String(timestamp),
    "x-iflow-signature": createIFlowSignature(userAgent, sessionId, timestamp, credential),
  };
}
