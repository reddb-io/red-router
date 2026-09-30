import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// `npx red-router` resolves to an unpublished package name (npm 404); the published
// package is scoped, so every npx hint shown in the UI must use `@reddb-io/red-router`.
const HINT_SOURCES = [
  "src/app/forgot-password/page.tsx",
  "src/lib/oauth/utils/googleLoopbackHint.ts",
];

test("UI npx hints use the scoped package name", () => {
  for (const file of HINT_SOURCES) {
    const source = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(source, /npx red-router\b/, `${file} must not use the unscoped name`);
    assert.match(source, /npx @reddb-io\/red-router /, `${file} must show the scoped npx command`);
  }
});
