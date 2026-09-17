#!/usr/bin/env node

// Postinstall: warm-up SQLite deps into ~/.red-router/runtime so the first
// `red-router` start doesn't need network. Failure here is non-fatal —
// cli.js will retry at runtime if anything is missing.
const { ensureSqliteRuntime } = require("./sqliteRuntime");
const { ensureTrayRuntime } = require("./trayRuntime");

try {
  ensureSqliteRuntime({ silent: false });
  console.log("[red-router] runtime SQLite deps ready");
} catch (e) {
  console.warn(`[red-router] runtime warm-up skipped: ${e.message}`);
}

try {
  ensureTrayRuntime({ silent: false });
} catch (e) {
  console.warn(`[red-router] tray runtime skipped: ${e.message}`);
}

process.exit(0);
