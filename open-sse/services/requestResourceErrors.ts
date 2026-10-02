function responseBodyToString(responseBody: unknown): string {
  if (typeof responseBody === "string") return responseBody;
  if (responseBody !== null && typeof responseBody === "object") {
    try {
      return JSON.stringify(responseBody);
    } catch {
      return "";
    }
  }
  return "";
}

// A provider can return 404 for request-scoped resources (conversation ids,
// Files API ids, response items, uploads, etc.). These failures describe the request payload,
// not provider/model health. Keep every expression bounded to avoid ReDoS on
// upstream-controlled error bodies.
const RESOURCE_NOT_FOUND_PATTERNS = [
  /\b(?:thread_not_found|previous_message(?:_id)?_not_found)\b/i,
  /\b(?:thread|previous[_ -]?message[_ -]?id)\b[^\n]{0,160}\b(?:not found|does not exist|unknown|invalid)\b/i,
  /\b(?:not found|does not exist|unknown|invalid)\b[^\n]{0,160}\b(?:thread|previous[_ -]?message[_ -]?id)\b/i,
  /\bfiles?\b[^\n]{0,160}\b(?:not found|does not exist)\b/i,
  /\b(?:not found|does not exist)\b[^\n]{0,160}\bfiles?\b/i,
  /\b(?:input[_ -]?file|file[_ -]?id|item|response|vector[_ -]?store|upload)\b[^\n]{0,160}\b(?:not found|does not exist)\b/i,
  /\b(?:not found|does not exist)\b[^\n]{0,160}\b(?:input[_ -]?file|file[_ -]?id|item|response|vector[_ -]?store|upload)\b/i,
  /\bfile-[a-z0-9_-]+\b[^\n]{0,160}\b(?:not found|does not exist)\b/i,
];

/**
 * Whether an upstream error identifies a missing request-scoped resource.
 *
 * Resource signals intentionally take precedence over an outer
 * `code: "model_not_found"` because compatibility layers may synthesize that
 * code from the HTTP status before preserving the upstream file error.
 */
export function isResourceNotFoundResponse(responseBody: unknown): boolean {
  const body = responseBodyToString(responseBody);
  return RESOURCE_NOT_FOUND_PATTERNS.some((pattern) => pattern.test(body));
}
