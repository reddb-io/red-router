import { defineConfig } from "vitest/config";
import base from "./vitest.config";
import { suiteFiles } from "./scripts/test/redrouter-suites.mjs";

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: suiteFiles("ui"),
    maxWorkers: 4,
    maxConcurrency: 4,
    coverage: { enabled: false },
  },
});
