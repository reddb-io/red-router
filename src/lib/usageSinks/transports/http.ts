/** Shared plumbing for usage sink transports: egress-guarded fetch and result helpers. */
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";
import {
  isCloudMetadataHost,
  isPrivateHost,
  OutboundUrlGuardError,
  parseOutboundUrl,
} from "@/shared/network/outboundUrlGuard";
import { arePrivateProviderUrlsAllowed } from "@/shared/network/outboundUrlGuardPolicy";
import { fetchWebhookUrl } from "@/shared/network/webhookFetch";
import type { DeliveryResult, HttpFetch } from "./types";

export const SEND_TIMEOUT_MS = 10_000;
/** How much of a remote error body is kept in a delivery's `last_error`. */
const DETAIL_LIMIT = 200;

/**
 * Egress-guarded HTTP for transports. It is `fetchWebhookUrl`: DNS is resolved up front, cloud
 * metadata addresses are always refused, private addresses are refused unless `allowPrivate`
 * (default: the operator's private-provider-URL opt-in), the connection is pinned to the
 * validated address and redirects are not followed. The signed webhook passes
 * `allowPrivate: false`: a billing callback never reaches a private network.
 */
export function createGuardedFetch(options: { allowPrivate?: boolean } = {}): HttpFetch {
  return async (url, init) => {
    const { response } = await fetchWebhookUrl(url, init, {
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      maxRedirects: 0,
      ...(options.allowPrivate === undefined ? {} : { allowPrivate: options.allowPrivate }),
    });
    return response;
  };
}

/**
 * Config-time counterpart of the send-time guard: refuse a URL whose literal host is cloud
 * metadata, or private without the opt-in. (Send time still resolves DNS and checks every
 * address, so a public-looking name that resolves inside the network is refused there.)
 */
export function egressUrlIssue(value: string, allowedProtocols: readonly string[]): string | null {
  let url: URL;
  try {
    url = parseOutboundUrl(value);
  } catch {
    return "Must be a valid http(s) URL without embedded credentials";
  }
  if (!allowedProtocols.includes(url.protocol)) {
    return `Must use ${allowedProtocols.map((p) => p.replace(":", "").toUpperCase()).join(" or ")}`;
  }
  if (isCloudMetadataHost(url.hostname)) return "Cloud metadata endpoints are not allowed";
  if (isPrivateHost(url.hostname) && !arePrivateProviderUrlsAllowed()) {
    return "Private and local addresses are blocked (enable private provider URLs to allow them)";
  }
  return null;
}

/** Same guard for a `host:port` broker. */
export function egressHostIssue(host: string): string | null {
  if (isCloudMetadataHost(host)) return "Cloud metadata endpoints are not allowed";
  if (isPrivateHost(host) && !arePrivateProviderUrlsAllowed()) {
    return "Private and local addresses are blocked (enable private provider URLs to allow them)";
  }
  return null;
}

/** `origin + path` of a URL: query strings can carry credentials, so they are never shown. */
export function displayUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

export function blankResult(target: string | null): DeliveryResult {
  return {
    ok: false,
    retryable: true,
    status: null,
    statusText: null,
    error: null,
    target,
    bytes: null,
    durationMs: null,
  };
}

/** A configuration failure: retrying the same delivery cannot fix it. */
export function permanentFailure(target: string | null, error: string): DeliveryResult {
  return { ...blankResult(target), retryable: false, error };
}

/** A caught error as a short, credential-free message. */
export function describeSendError(error: unknown): string {
  if (error instanceof OutboundUrlGuardError) return "Destination blocked by the egress policy";
  if (error instanceof Error && error.name === "TimeoutError") {
    return `Timed out after ${SEND_TIMEOUT_MS / 1000}s`;
  }
  const message = error instanceof Error ? error.message : error;
  return sanitizeErrorMessage(message).slice(0, DETAIL_LIMIT) || "Request failed";
}

/** Fold an HTTP response into a result (status, size, duration). `ok` is decided by the caller. */
export async function readResponse(
  response: Response,
  result: DeliveryResult,
  started: number
): Promise<{ result: DeliveryResult; text: string }> {
  const text = await response.text().catch(() => "");
  return {
    text,
    result: {
      ...result,
      durationMs: Date.now() - started,
      status: response.status,
      statusText: response.statusText || null,
      bytes: Buffer.byteLength(text),
    },
  };
}

/** A remote error detail: capped and passed through the shared sanitizer. */
export function remoteDetail(text: string): string {
  return sanitizeErrorMessage(text.slice(0, DETAIL_LIMIT * 2)).slice(0, DETAIL_LIMIT);
}
