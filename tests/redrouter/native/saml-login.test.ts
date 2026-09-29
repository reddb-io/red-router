import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { SignedXml } from "xml-crypto";

const dataDir = mkdtempSync(join(tmpdir(), "redrouter-saml-"));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = "test-jwt-secret-for-saml";
process.env.BASE_URL = "http://localhost:20128";

const core = await import("../../../src/lib/db/core.ts");
const { updateSettings, getSettings } = await import("../../../src/lib/db/settings.ts");
const samlLib = await import("../../../src/lib/auth/saml.ts");
const startRoute = await import("../../../src/app/api/auth/saml/start/route.ts");
const acsRoute = await import("../../../src/app/api/auth/saml/acs/route.ts");
const metadataRoute = await import("../../../src/app/api/auth/saml/metadata/route.ts");
const testRoute = await import("../../../src/app/api/auth/saml/test/route.ts");
const guard = await import("../../../src/server/auth/loginGuard.ts");

// A throwaway IdP key pair and certificate; the second pair stands for an attacker's own IdP.
function makeIdentity(name: string) {
  const keyPath = join(dataDir, `${name}.key`);
  const certPath = join(dataDir, `${name}.crt`);
  const result = spawnSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath,
    "-subj", `/CN=${name}.test`, "-days", "2",
  ]);
  assert.equal(result.status, 0, "openssl is needed to generate a test certificate");
  return { key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8") };
}
const idp = makeIdentity("idp");
const attacker = makeIdentity("attacker");

const ACS = "http://localhost:20128/api/auth/saml/acs";
const ISSUER = "urn:red-router:sp";

function assertionXml(opts: { requestId: string; email: string; audience?: string; notOnOrAfter?: string }) {
  const now = new Date();
  const later = new Date(now.getTime() + 5 * 60_000).toISOString();
  const before = new Date(now.getTime() - 60_000).toISOString();
  return `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_assertion1" Version="2.0" IssueInstant="${now.toISOString()}"><saml:Issuer>https://idp.test</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${opts.email}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${opts.requestId}" NotOnOrAfter="${opts.notOnOrAfter ?? later}" Recipient="${ACS}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${before}" NotOnOrAfter="${later}"><saml:AudienceRestriction><saml:Audience>${opts.audience ?? ISSUER}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${now.toISOString()}" SessionIndex="_session1"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement><saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>${opts.email}</saml:AttributeValue></saml:Attribute></saml:AttributeStatement></saml:Assertion>`;
}

function responseXml(requestId: string | null, assertion: string) {
  const inResponseTo = requestId ? ` InResponseTo="${requestId}"` : "";
  return `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_response1" Version="2.0" IssueInstant="${new Date().toISOString()}" Destination="${ACS}"${inResponseTo}><saml:Issuer>https://idp.test</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${assertion}</samlp:Response>`;
}

function signAssertion(xml: string, identity: { key: string; cert: string }) {
  const sig = new SignedXml({
    privateKey: identity.key,
    publicCert: identity.cert,
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
  });
  sig.addReference({
    xpath: "//*[local-name(.)='Assertion']",
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
    transforms: [
      "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
      "http://www.w3.org/2001/10/xml-exc-c14n#",
    ],
  });
  sig.computeSignature(xml, {
    location: { reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: "after" },
  });
  return sig.getSignedXml();
}

const b64 = (xml: string) => Buffer.from(xml, "utf8").toString("base64");

const pendingIds = () =>
  [...((globalThis as { __redRouterSamlRequests?: Map<string, unknown> }).__redRouterSamlRequests ?? new Map()).keys()];

async function begin(test = false) {
  const response = await startRoute.GET(
    new Request(`http://localhost:20128/api/auth/saml/start${test ? "?test=1" : ""}`)
  );
  return { response, ids: pendingIds() };
}

const postAcs = (samlResponse: string) => {
  const form = new FormData();
  form.set("SAMLResponse", samlResponse);
  return acsRoute.POST(new Request(ACS, { method: "POST", body: form }));
};

const location = (response: Response) => response.headers.get("location") ?? "";

beforeEach(async () => {
  core.resetDbInstance();
  rmSync(join(dataDir, "storage.sqlite"), { force: true });
  mkdirSync(dataDir, { recursive: true });
  guard.resetLoginGuardForTests();
  (globalThis as { __redRouterSamlRequests?: Map<string, unknown> }).__redRouterSamlRequests?.clear();
  await updateSettings({
    requireLogin: true,
    samlEnabled: true,
    samlEntryPoint: "https://idp.test/sso",
    samlCert: idp.cert,
    samlAllowedEmails: ["admin@example.com"],
  });
});

after(() => {
  core.resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

test("start sends the browser to the IdP with an AuthnRequest and remembers its id", async () => {
  const { response, ids } = await begin();
  assert.equal(response.status, 307);
  const target = new URL(location(response));
  assert.equal(target.origin + target.pathname, "https://idp.test/sso");
  assert.ok(target.searchParams.get("SAMLRequest"));
  assert.equal(ids.length, 1);
});

test("a signed response to our request opens a session for an allowed e-mail", async () => {
  const { ids } = await begin();
  const signed = signAssertion(responseXml(ids[0], assertionXml({ requestId: ids[0], email: "admin@example.com" })), idp);
  const response = await postAcs(b64(signed));
  assert.equal(response.status, 303);
  assert.match(location(response), /\/dashboard$/);
  assert.match(response.headers.getSetCookie().join("\n"), /auth_token=/);
  assert.equal((await getSettings()).setupComplete, true);
});

test("the same response cannot be replayed", async () => {
  const { ids } = await begin();
  const signed = b64(signAssertion(responseXml(ids[0], assertionXml({ requestId: ids[0], email: "admin@example.com" })), idp));
  assert.match(location(await postAcs(signed)), /\/dashboard$/);
  const again = await postAcs(signed);
  assert.match(location(again), /saml_error=invalid_response/);
  assert.equal(again.headers.getSetCookie().join("").includes("auth_token"), false);
});

test("an IdP-initiated response (no request of ours) is refused", async () => {
  const signed = signAssertion(responseXml(null, assertionXml({ requestId: "_unsolicited", email: "admin@example.com" })), idp);
  assert.match(location(await postAcs(b64(signed))), /saml_error=invalid_response/);
});

test("a response for a request we never sent is refused", async () => {
  await begin();
  const signed = signAssertion(responseXml("_forged", assertionXml({ requestId: "_forged", email: "admin@example.com" })), idp);
  assert.match(location(await postAcs(b64(signed))), /saml_error=invalid_response/);
});

test("an unsigned assertion is refused", async () => {
  const { ids } = await begin();
  const unsigned = responseXml(ids[0], assertionXml({ requestId: ids[0], email: "admin@example.com" }));
  const response = await postAcs(b64(unsigned));
  assert.match(location(response), /saml_error=invalid_response/);
  assert.equal(response.headers.getSetCookie().join("").includes("auth_token"), false);
});

test("an assertion signed by another key is refused", async () => {
  const { ids } = await begin();
  const forged = signAssertion(responseXml(ids[0], assertionXml({ requestId: ids[0], email: "admin@example.com" })), attacker);
  assert.match(location(await postAcs(b64(forged))), /saml_error=invalid_response/);
});

test("an assertion for another audience is refused", async () => {
  const { ids } = await begin();
  const signed = signAssertion(
    responseXml(ids[0], assertionXml({ requestId: ids[0], email: "admin@example.com", audience: "urn:someone:else" })),
    idp
  );
  assert.match(location(await postAcs(b64(signed))), /saml_error=invalid_response/);
});

test("an e-mail that is not on the allow list is not let in", async () => {
  const { ids } = await begin();
  const signed = signAssertion(responseXml(ids[0], assertionXml({ requestId: ids[0], email: "intruder@example.com" })), idp);
  const response = await postAcs(b64(signed));
  assert.match(location(response), /saml_error=not_allowed/);
  assert.equal(response.headers.getSetCookie().join("").includes("auth_token"), false);
});

test("a test sign-in needs a session to start, and reports back without opening one", async () => {
  const denied = await startRoute.GET(new Request("http://localhost:20128/api/auth/saml/start?test=1"));
  assert.equal(denied.status, 401);

  await updateSettings({ requireLogin: false });
  const { ids } = await begin(true);
  const signed = signAssertion(responseXml(ids[0], assertionXml({ requestId: ids[0], email: "admin@example.com" })), idp);
  const response = await postAcs(b64(signed));
  assert.match(location(response), /\/dashboard\/settings\/security\?saml_test=ok/);
  assert.equal(response.headers.getSetCookie().join("").includes("auth_token"), false);
});

test("nothing is accepted while SAML is off or incomplete", async () => {
  await updateSettings({ samlEnabled: false });
  assert.match(location(await postAcs(b64("<x/>"))), /saml_error=not_configured/);
  const start = await startRoute.GET(new Request("http://localhost:20128/api/auth/saml/start"));
  assert.match(location(start), /saml_error=not_configured/);

  await updateSettings({ samlEnabled: true, samlAllowedEmails: [] });
  assert.equal(samlLib.isSamlEnabled(await getSettings()), false, "an empty allow list is not usable");
  await updateSettings({ samlAllowedEmails: ["admin@example.com"], samlEntryPoint: "http://idp.example.org/sso" });
  assert.equal(samlLib.isSamlEnabled(await getSettings()), false, "the entry point must be https");
});

test("garbage in the form is a fixed error, never a stack", async () => {
  await begin();
  const response = await postAcs("not-xml-at-all");
  assert.match(location(response), /saml_error=invalid_response/);
});

test("metadata is public but only once the setup is complete", async () => {
  const ok = await metadataRoute.GET(new Request("http://localhost:20128/api/auth/saml/metadata"));
  assert.equal(ok.status, 200);
  const xml = await ok.text();
  assert.match(xml, /EntityDescriptor/);
  assert.ok(xml.includes(ACS));
  assert.ok(xml.includes(ISSUER));

  await updateSettings({ samlEntryPoint: "" });
  const missing = await metadataRoute.GET(new Request("http://localhost:20128/api/auth/saml/metadata"));
  assert.equal(missing.status, 404);
});

test("the static check needs a management session and never echoes settings", async () => {
  const denied = await testRoute.POST(new Request("http://localhost:20128/api/auth/saml/test", { method: "POST" }));
  assert.equal(denied.status, 401);
  await updateSettings({ requireLogin: false });
  const result = await (await testRoute.POST(new Request("http://localhost:20128/api/auth/saml/test", { method: "POST" }))).json();
  assert.equal(result.ok, true);
  assert.ok(!JSON.stringify(result).includes("BEGIN CERTIFICATE"));
});
