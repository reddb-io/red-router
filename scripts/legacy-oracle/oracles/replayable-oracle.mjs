import { readFileSync, writeFileSync } from "node:fs";
// The legacy module imports the whole provider registry; evaluate just the
// function (and its asRecord helper) from source.
const src = readFileSync(process.argv[2], "utf8");
const grab = (startMarker, endMarker) => {
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error(`missing ${startMarker}`);
  return src.slice(start, end);
};
const asRecordSrc = grab("function asRecord(", "function isNonEmptyString");
const fnSrc = grab("export function extractReplayableResponsesReasoningText", "export function hasOpaqueReasoningState");
const strip = (text) => text.replace(/: JsonRecord \| null/g, "").replace(/\(value: unknown\)/g, "(value)").replace(/: unknown/g, "").replace(/: string/g, "").replace(/ as JsonRecord/g, "").replace(/^export /gm, "");
const make = new Function(`${strip(asRecordSrc)}\n${strip(fnSrc)}\nreturn extractReplayableResponsesReasoningText;`);
const extract = make();
const cases = [
  null, 5, "x", [], {}, { type: "message" }, { type: "reasoning" }, { type: "reasoning", content: "no" },
  { type: "reasoning", content: [] },
  { type: "reasoning", content: [{ type: "reasoning_text", text: "a" }] },
  { type: "reasoning", content: [{ type: "reasoning_text", text: "a" }, { type: "reasoning_text", text: "b" }] },
  { type: "reasoning", content: [{ type: "reasoning_text", text: "  " }, { type: "reasoning_text", text: "kept" }, { type: "reasoning_text", text: "" }] },
  { type: "reasoning", content: [{ type: "other", text: "x" }, { type: "reasoning_text", text: 5 }, null, "str", { type: "reasoning_text" }] },
  { type: "reasoning", content: [{ type: "reasoning_text", text: " padded " }] },
  { type: "reasoning", summary: [{ text: "summary only" }] },
];
writeFileSync(process.argv[3], JSON.stringify(cases.map((c) => [c, extract(c)])));
console.log("ok", cases.length);
