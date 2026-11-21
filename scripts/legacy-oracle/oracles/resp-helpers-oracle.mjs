import { writeFileSync } from "node:fs";
const m = await import(process.argv[2]);
const out = {
  verbosity: [undefined, null, 5, "low", "HIGH", "Medium", "extreme", ""].map((v) => [v === undefined ? "__undefined" : v, m.normalizeVerbosity(v) ?? null]),
  clamp: ["abc", "x".repeat(64), "x".repeat(65), "y".repeat(100), ""].map((v) => [v, m.clampCallId(v)]),
  effort: [
    ["max", "gpt-5.6-sol"], ["MAX", "codex/gpt-5.6-terra-high"], ["max", "cx/gpt-6-astra"], ["max", "gpt-6.1-sol-ultra"],
    ["max", "kiro/gpt-5.6-luna-max"], ["max", "kr/gpt-5.6-sol"], ["max", "gpt-4o"], ["max", null], ["high", "gpt-5.6-sol"],
    ["", "x"], [null, "x"], ["Low", "x"], ["max", "gpt-6-astra-bogus"],
  ].map(([v, model]) => [v, model, m.normalizeResponsesReasoningEffort(v, model)]),
  summary: ["auto", "OFF", "none", "disabled", "", null, "detailed", "concise"].map((v) => [v, m.shouldRequestClaudeSummarizedThinking(v)]),
  image: ["http://x/a.png", { url: "u" }, { url: 5 }, null, [], 7].map((v) => [JSON.stringify(v), m.imageUrlToText(v)]),
};
writeFileSync(process.argv[3], JSON.stringify(out));
console.log("ok");
