import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
import { suiteFiles } from "./scripts/test/redrouter-suites.mjs";

export default defineConfig({
  ...base,
  testDir: ".",
  testMatch: suiteFiles("e2e"),
  testIgnore: [],
});
