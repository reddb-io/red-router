import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// Audit attribution: an action is credited to the identity carried by the session, not to a
// generic "admin".
const dataDir = mkdtempSync(join(tmpdir(), "redrouter-audit-actor-"));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = "test-jwt-secret-for-audit-actor";
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "audit-actor-test-secret";

const { resetDbInstance } = await import("../../../src/lib/db/core.ts");
const {
  DASHBOARD_SESSION_COOKIE,
  getDashboardJwtSecret,
  mintDashboardSessionToken,
  verifyDashboardSessionToken,
} = await import("../../../src/shared/utils/dashboardSessionToken.ts");
const { auditActorFor } = await import("../../../src/lib/compliance/auditActor.ts");
const { createApiKey } = await import("../../../src/lib/db/apiKeys.ts");

after(() => {
  resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

const secret = () => getDashboardJwtSecret()!;
const withCookie = (token: string) =>
  new Request("http://localhost/api/x", {
    headers: { cookie: `${DASHBOARD_SESSION_COOKIE}=${token}` },
  });

test("a session carries the identity it was minted for", async () => {
  for (const subject of ["owner", "oidc:alice@example.com", "saml:bob@example.com"]) {
    const token = await mintDashboardSessionToken(secret(), subject);
    assert.equal((await verifyDashboardSessionToken(token, secret()))?.sub, subject);
    assert.equal(await auditActorFor(withCookie(token)), subject);
  }
});

test("a session minted before identities existed belongs to the owner", async () => {
  const token = await mintDashboardSessionToken(secret());
  assert.equal((await verifyDashboardSessionToken(token, secret()))?.sub, undefined);
  assert.equal(await auditActorFor(withCookie(token)), "owner");
});

test("a management key is named by its id, never by its value", async () => {
  const key = await createApiKey("ops", "audit-actor-machine", ["manage"]);
  const actor = await auditActorFor(
    new Request("http://localhost/api/x", { headers: { authorization: `Bearer ${key.key}` } })
  );
  assert.equal(actor, `api-key:${key.id}`);
  assert.ok(!actor.includes(key.key));
});

test("no authenticated caller falls back to the legacy label, and a bad session is not trusted", async () => {
  assert.equal(await auditActorFor(new Request("http://localhost/api/x")), "admin");
  assert.equal(await auditActorFor(null), "admin");
  assert.equal(await auditActorFor(withCookie("not.a.jwt")), "admin");
  // A forged subject on a token with the wrong secret is ignored.
  const forged = await mintDashboardSessionToken(
    new TextEncoder().encode("another-secret-entirely"),
    "owner"
  );
  assert.equal(await auditActorFor(withCookie(forged)), "admin");
});
