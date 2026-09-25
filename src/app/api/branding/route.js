import { loadBranding, publicBranding } from "@/lib/branding";

export const dynamic = "force-dynamic";

// GET /api/branding: the white-label identity, public (the login page needs it).
export async function GET() {
  return Response.json(publicBranding(loadBranding()), { headers: { "Cache-Control": "no-store" } });
}
