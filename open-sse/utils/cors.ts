/**
 * Static CORS headers for open-sse handlers.
 *
 * `Access-Control-Allow-Origin` is set by the Next.js middleware
 * (`src/server/cors/origins.ts`). Handlers in this package only need the
 * methods/headers list; the middleware overlays the allowed origin per
 * the central allowlist on the way out.
 */
import {
  RED_ROUTER_REQUEST_HEADERS,
  RED_ROUTER_RESPONSE_HEADERS,
} from "@/shared/constants/redRouterHeaders";

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, x-api-key, anthropic-version, x-omniroute-connection, x-internal-test, accept, " +
    RED_ROUTER_REQUEST_HEADERS.join(", "),
  // Browser clients can only read response headers listed here.
  "Access-Control-Expose-Headers": RED_ROUTER_RESPONSE_HEADERS.join(", "),
};
