import { writeFileSync } from "node:fs";
const m = await import(process.argv[2]);
const cases = [
  {}, null, "str", [], { reasoning_content: "rc" }, { reasoning: "r" }, { reasoning_content: "", reasoning: "r2" },
  { reasoning_content: 5, reasoning: "r3" }, { reasoning_text: "rt" }, { thinking: "t" },
  { reasoning_details: [{ text: "d1" }, { content: "d2" }, { text: "" , content: "d3"}] },
  { reasoning_content: "keep", reasoning_text: "x" }, { reasoning_details: "nope" },
  { reasoning: "", reasoning_content: "" },
];
writeFileSync(process.argv[3], JSON.stringify(cases.map((c) => [c, m.getReadableReasoningValue(c), m.getUnsupportedReasoningValue(c)])));
console.log("ok", cases.length);
