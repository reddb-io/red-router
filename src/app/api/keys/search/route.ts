import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { searchApiKeyRefs } from "@/lib/db/apiKeyLookup";
import { keySearchQuerySchema } from "@/lib/usageSinks/inputSchemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

/**
 * GET /api/keys/search?q=&limit=&offset=: API keys by name, a page at a time, id and name only
 * (never the key). Built for pickers that must work the same with five keys or fifty thousand.
 */
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const query = Object.fromEntries(new URL(request.url).searchParams);
  const parsed = validateBody(keySearchQuerySchema, query);
  if (isValidationFailure(parsed)) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  return NextResponse.json(searchApiKeyRefs(parsed.data));
}
