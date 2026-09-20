// Gate: so kết quả test hiện tại với baseline known-fails.
// PASS nếu KHÔNG có test nào pass(baseline) → fail(now). Test mới được phép.
// Usage: node tests/__baseline__/verify-no-regression.mjs <current-results.json>
import { readFileSync } from "fs";
import { failedTestNames } from "./paths.mjs";

const resultsPath = process.argv[2];
if (!resultsPath) { console.error("Missing results.json path"); process.exit(2); }
const baselinePath = process.argv[3];

let knownFails;
try {
  knownFails = baselinePath
    ? new Set(failedTestNames(JSON.parse(readFileSync(baselinePath, "utf8"))))
    : new Set(
        readFileSync(new URL("./known-fails.txt", import.meta.url), "utf8")
          .split("\n").map(s => s.trim()).filter(Boolean)
      );
} catch (error) {
  console.error(`Invalid baseline: ${error.message}`);
  process.exit(2);
}

let nowFails;
try {
  nowFails = failedTestNames(JSON.parse(readFileSync(resultsPath, "utf8")));
} catch (error) {
  console.error(`Invalid Vitest results: ${error.message}`);
  process.exit(2);
}

// Regression = fail bây giờ NHƯNG không có trong baseline known-fails
const regressions = nowFails.filter(f => !knownFails.has(f));

if (regressions.length) {
  console.error(`\n❌ REGRESSION: ${regressions.length} test pass→fail:\n`);
  regressions.forEach(f => console.error("  - " + f));
  process.exit(1);
}
console.log(`✅ No regression. (now fails=${nowFails.length}, baseline fails=${knownFails.size}, all known)`);
