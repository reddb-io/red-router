import { NextResponse } from "next/server";
import { getSettings } from "@/lib/db/settings";
import { generateSamlMetadata, samlConfigProblem } from "@/lib/auth/saml";

export const dynamic = "force-dynamic";

/** GET /api/auth/saml/metadata - the service-provider metadata to register at the identity provider. */
export async function GET(request: Request) {
  const settings = await getSettings();
  // Metadata only needs the issuer and the ACS address; it is public by design (the IdP fetches it).
  // It is withheld until the setup is complete so an unconfigured install does not advertise itself.
  if (samlConfigProblem(settings)) {
    return NextResponse.json({ error: "SAML is not configured." }, { status: 404 });
  }
  try {
    return new NextResponse(generateSamlMetadata(request, settings), {
      headers: { "Content-Type": "application/samlmetadata+xml; charset=utf-8" },
    });
  } catch {
    return NextResponse.json({ error: "SAML metadata is unavailable." }, { status: 500 });
  }
}
