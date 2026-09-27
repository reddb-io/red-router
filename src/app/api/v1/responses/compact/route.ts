import { handleResponsesPost, OPTIONS as responsesOptions } from "../route";

export const OPTIONS = responsesOptions;

/** JSON-only Responses compaction shares admission and security checks with /v1/responses. */
export function POST(request: Request): Promise<Response> {
  return handleResponsesPost(request, true);
}
