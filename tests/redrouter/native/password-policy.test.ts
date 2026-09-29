import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "redrouter-password-policy-"));
process.env.DATA_DIR = dataDir;
const core = await import("../../../src/lib/db/core.ts");
const { updateSettings, getSettings } = await import("../../../src/lib/db/settings.ts");
const policy = await import("../../../src/lib/auth/passwordPolicy.ts");
const settingsRoute = await import("../../../src/app/api/settings/route.ts");

beforeEach(async () => {
  core.resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  await updateSettings({ requireLogin: false });
});

after(() => {
  core.resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

test("the policy refuses short, common and repetitive passwords", () => {
  assert.equal(policy.checkPasswordPolicy("short"), "too_short");
  assert.equal(policy.checkPasswordPolicy("password"), "too_common");
  assert.equal(policy.checkPasswordPolicy("Password1"), "too_common");
  assert.equal(policy.checkPasswordPolicy("Tr0ub4dor&3x"), null);
  assert.equal(policy.checkPasswordPolicy("aaaaaaaaaa"), "repetitive");
  assert.equal(policy.checkPasswordPolicy("a".repeat(201)), "too_long");
  assert.equal(policy.checkPasswordPolicy("correct horse battery staple"), null);
});

const sha1 = (value: string) => createHash("sha1").update(value).digest("hex").toUpperCase();

test("the breach check sends only a five character prefix and reads the count", async () => {
  const password = "hunter2hunter2";
  const hash = sha1(password);
  let requested = "";
  const fetchImpl = (async (url: string) => {
    requested = String(url);
    return new Response(`0000000000000000000000000000000000A:3\r\n${hash.slice(5)}:42\r\n`);
  }) as unknown as typeof fetch;
  assert.equal(await policy.breachCount(password, fetchImpl), 42);
  assert.equal(requested, `https://api.pwnedpasswords.com/range/${hash.slice(0, 5)}`);
  assert.ok(!requested.includes(password) && !requested.includes(hash.slice(5)));

  const clean = (async () => new Response("ABCDEF:1\r\n")) as unknown as typeof fetch;
  assert.equal(await policy.breachCount(password, clean), 0);
});

test("the breach check fails open when the service cannot be asked", async () => {
  const broken = (async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch;
  assert.equal(await policy.breachCount("whatever-long-1", broken), null);
  const down = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
  assert.equal(await policy.breachCount("whatever-long-1", down), null);
});

const patch = (body: unknown) =>
  settingsRoute.PATCH(
    new Request("http://localhost/api/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );

test("the settings route refuses a weak new password and stores a good one", async () => {
  const weak = await patch({ newPassword: "short" });
  assert.equal(weak.status, 400);
  assert.equal((await weak.json()).error.code, "PASSWORD_POLICY");
  assert.equal((await getSettings()).password ?? "", "");

  const ok = await patch({ newPassword: "a long enough passphrase" });
  assert.equal(ok.status, 200);
  assert.match(String((await getSettings()).password), /^\$2[aby]\$/);
});
