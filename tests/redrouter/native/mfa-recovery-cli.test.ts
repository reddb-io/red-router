import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "redrouter-mfa-recovery-"));
process.env.DATA_DIR = dataDir;
const core = await import("../../../src/lib/db/core.ts");
const { updateSettings, getSettings } = await import("../../../src/lib/db/settings.ts");
const mfa = await import("../../../src/lib/db/mfa.ts");
const { totpCode } = await import("../../../src/lib/auth/totp.ts");

after(() => {
  core.resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

function runCli() {
  return spawnSync(
    process.execPath,
    [join(process.cwd(), "bin", "reset-password.mjs"), "--disable-mfa"],
    {
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        CI: "1",
        NO_UPDATE_NOTIFIER: "1",
        OMNIROUTE_CLI_SKIP_REPO_ENV: "1",
      },
      encoding: "utf8",
      timeout: 60_000,
    }
  );
}

test("reset-password --disable-mfa removes the owner's second factor and keeps the password", async () => {
  await updateSettings({
    requireLogin: true,
    password: "$2a$10$storedhashstoredhashstoredhashstoredhashstoredhashstor",
  });
  const started = mfa.beginMfaSetup(mfa.OWNER_PRINCIPAL)!;
  assert.ok(mfa.enableMfa(mfa.OWNER_PRINCIPAL, totpCode(started.secret)));
  assert.equal(mfa.isMfaEnabled(mfa.OWNER_PRINCIPAL), true);
  core.resetDbInstance();

  const result = runCli();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /second factor is off/i);

  assert.equal(mfa.isMfaEnabled(mfa.OWNER_PRINCIPAL), false);
  assert.match(
    String((await getSettings()).password),
    /^\$2a\$10\$storedhash/,
    "the password is untouched"
  );
});

test("with no second factor enabled the command says so and changes nothing", () => {
  const result = runCli();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /No second factor was enabled/);
});
