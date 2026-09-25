import { readBrandingAsset } from "@/lib/branding";

export const dynamic = "force-dynamic";

// GET /api/branding/asset/{logo|logoDark|favicon|loginBackground}: an image the
// branding names as a file next to branding.json. Public, like the login page.
export async function GET(_request, { params }) {
  const { field } = await params;
  const asset = readBrandingAsset(field);
  if (!asset) return new Response("Not found", { status: 404 });
  return new Response(asset.body, {
    headers: {
      "Content-Type": asset.type,
      "Cache-Control": "no-cache",
      // An SVG logo must not run scripts when opened directly.
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
