import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "redrouter-sso-recovery-"));
process.env.DATA_DIR = dataDir;
const core = await import("../../../src/lib/db/core.ts");
const { getSettings, updateSettings } = await import("../../../src/lib/db/settings.ts");

after(() => {
  core.resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

test("reset-password --disable-sso switches SSO off, password login on, and keeps the password", async () => {
  await updateSettings({
    requireLogin: true,
    password: "$2a$10$storedhashstoredhashstoredhashstoredhashstoredhashstor",
    oidcEnabled: true,
    oidcDisablePasswordLogin: true,
    oidcLastTestSucceededAt: "2026-09-29T00:00:00Z",
  });
  core.resetDbInstance();

  const result = spawnSync(
    process.execPath,
    [join(process.cwd(), "bin", "reset-password.mjs"), "--disable-sso"],
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
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Single sign-on is off/);

  const settings = await getSettings();
  assert.equal(settings.oidcEnabled, false);
  assert.equal(settings.oidcDisablePasswordLogin, false);
  assert.equal(settings.oidcLastTestSucceededAt ?? null, null);
  assert.match(String(settings.password), /^\$2a\$10\$storedhash/, "the password is untouched");
  assert.equal(settings.requireLogin, true);
});
