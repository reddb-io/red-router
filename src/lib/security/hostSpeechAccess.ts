import { isLoopbackRequest } from "@/shared/utils/apiAuth";

/** A URL/Host header alone must never authorize a host subprocess. */
export function canUseHostSpeech(request: Request | null | undefined): boolean {
  return Boolean(request && process.env.OMNIROUTE_PEER_STAMP_TOKEN && isLoopbackRequest(request));
}
