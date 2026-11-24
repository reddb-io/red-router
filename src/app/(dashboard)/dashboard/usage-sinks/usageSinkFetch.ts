"use client";

import {
  readRustAdminCsrfCookie,
  rustUsageSinkFetch,
} from "@/lib/rustControlPlane/browserClient";

/**
 * The same SPA runs against both authorities. A Rust admin session has the
 * CSRF cookie; the legacy Next backend keeps using its existing authenticated
 * same-origin routes when that cookie is absent.
 */
export function usageSinkFetch(path: string, init?: RequestInit): Promise<Response> {
  return readRustAdminCsrfCookie() ? rustUsageSinkFetch(path, init) : fetch(path, init);
}
