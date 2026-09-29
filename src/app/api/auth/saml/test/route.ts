import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getSettings } from "@/lib/db/settings";
import {
  formatX509Certificate,
  generateSamlMetadata,
  resolveSamlBaseUrl,
  samlConfigProblem,
} from "@/lib/auth/saml";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/saml/test
 * Static checks of the saved SAML setup (no network, nobody is signed in): the configuration is
 * complete, the certificate parses and the SP metadata builds. A real check is
 * `GET /api/auth/saml/start?test=1`. Every detail is a fixed sentence.
 */
export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const settings = await getSettings();
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  const problem = samlConfigProblem(settings);
  checks.push({
    name: "configuration",
    ok: problem === null,
    detail: problem ?? "The sign-in URL, certificate and allow list are set.",
  });

  let certOk = false;
  try {
    const { X509Certificate } = await import("node:crypto");
    const cert = new X509Certificate(formatX509Certificate(settings.samlCert));
    certOk = new Date(cert.validTo).getTime() > Date.now();
    checks.push({
      name: "certificate",
      ok: certOk,
      detail: certOk
        ? "The certificate parses and has not expired."
        : "The certificate has expired.",
    });
  } catch {
    checks.push({
      name: "certificate",
      ok: false,
      detail: "The certificate could not be read. Paste the PEM or base64 X.509 certificate.",
    });
  }

  let metadataOk = false;
  if (problem === null) {
    try {
      metadataOk = generateSamlMetadata(request, settings).length > 0;
    } catch {
      metadataOk = false;
    }
    checks.push({
      name: "metadata",
      ok: metadataOk,
      detail: metadataOk
        ? `Register ${resolveSamlBaseUrl(request, settings)}/api/auth/saml/metadata at your identity provider.`
        : "The service-provider metadata could not be built.",
    });
  }

  return NextResponse.json({ ok: checks.every((check) => check.ok), checks });
}
