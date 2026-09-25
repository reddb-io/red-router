import { NextResponse } from "next/server";
import { searchApiKeys } from "@/lib/db/repos/apiKeysRepo.js";
import { getScopeFilter } from "@/lib/auth/resourceScope";

export const dynamic = "force-dynamic";

// GET /api/keys/search?q=&ids=a,b&limit=&offset= — a page of keys for pickers,
// without loading every key and without secrets.
export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const ids = params.get("ids");
  const filter = await getScopeFilter();
  const result = await searchApiKeys({
    q: params.get("q") || "",
    ids: ids === null ? null : ids.split(",").map((s) => s.trim()).filter(Boolean),
    limit: params.get("limit"),
    offset: params.get("offset"),
    owner: filter ? filter.owner ?? null : undefined,
  });
  return NextResponse.json(result);
}
