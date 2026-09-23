import { randomUUID } from "node:crypto";

// Marks a request the router makes to itself (the smart-combo classifier calling
// /v1/systemone on behalf of a chat request). The token is random per process, so
// an outside client cannot claim it; an internal call is exempt from the checks
// its parent request already passed (key limits, model rules) — it would
// otherwise count twice against rpm or be denied a model the key never named.
export const INTERNAL_CALL_HEADER = "x-red-router-internal";
const INTERNAL_TOKEN = randomUUID();

export function internalCallHeaders() {
  return { [INTERNAL_CALL_HEADER]: INTERNAL_TOKEN };
}

export function isInternalCall(request) {
  return request?.headers?.get?.(INTERNAL_CALL_HEADER) === INTERNAL_TOKEN;
}
