import { readFileSync, writeFileSync } from "node:fs";
// The three helpers are module-private in the legacy file: evaluate them from source.
const src = readFileSync(process.argv[2], "utf8");
const start = src.indexOf("function mapChatResponseFormatToResponsesText");
const end = src.indexOf("export function openaiToOpenAIResponsesRequest");
const body = src.slice(start, end);
const helpers = `
const toRecord = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const toString = (v, f = "") => (typeof v === "string" ? v : f);
${body.replace(/: JsonRecord/g, "").replace(/: unknown\[\]/g, "").replace(/: unknown/g, "").replace(/: string/g, "").replace(/: void/g, "")}
return { mapChatResponseFormatToResponsesText, buildInstructionsText, buildResponsesTextParts };`;
const { mapChatResponseFormatToResponsesText: map, buildInstructionsText: instr, buildResponsesTextParts: parts } = new Function(helpers)();
const contents = [
  "plain", "", null, undefined, 5, [],
  ["a", "b"], [{ type: "text", text: "x" }, { type: "image_url", image_url: { url: "u" } }, { text: "y" }, "z"],
  [{ type: "image_url" }], [{ type: "text", text: 7 }], [{ type: "text" }],
];
const bodies = [
  {}, { response_format: { type: "json_object" } },
  { response_format: { type: "json_schema", json_schema: { schema: { a: 1 } } } },
  { response_format: { type: "json_schema", json_schema: { name: "n", schema: { a: 1 }, description: "d", strict: true } } },
  { response_format: { type: "json_schema", json_schema: { name: "n" } } },
  { response_format: { type: "text" } },
];
const existing = [undefined, { verbosity: "low" }];
const out = {
  instructions: contents.map((c) => [c === undefined ? "__undefined" : c, instr(c)]),
  parts: contents.map((c) => [c === undefined ? "__undefined" : c, parts(c)]),
  format: bodies.flatMap((b) => existing.map((e) => { const r = e ? { text: structuredClone(e) } : {}; map(b, r); return [b, e ?? null, r]; })),
};
writeFileSync(process.argv[3], JSON.stringify(out));
console.log("ok", out.format.length);
