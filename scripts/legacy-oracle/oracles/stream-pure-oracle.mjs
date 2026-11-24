import { writeFileSync } from "node:fs";
const m = await import(`${process.argv[2]}/open-sse/translator/response/openai-responses/pureHelpers.ts`);

const schemaA = {
  type: "object",
  properties: {
    pages: { type: "string" },
    path: { type: "string" },
    mode: { type: "string", default: "fast" },
    note: { type: "string", description: "optional null = omit this parameter", enum: ["a", null] },
    flag: { type: ["boolean", "null"], description: "x null = omit this parameter" },
    count: { type: "number", default: 3 },
    nothing: { default: null },
    obj: { default: { a: 1, b: 2 } },
    list: { default: [] },
  },
  required: ["path", "note"],
};
const schemaNoRequired = { properties: { a: { type: "string" }, b: {} } };
const schemaWeird = { properties: [], required: "path" };
const args = [
  `{"path":"","pages":"","mode":"fast","extra":""}`,
  `{"z":1,"a":"","m":[],"b":2}`,
  `{"note":null,"flag":null,"path":null,"other":null}`,
  `{"count":3,"mode":"slow","nothing":null,"obj":{"a":1,"b":2},"list":[]}`,
  `{"count":3.0,"obj":{"a":1,"b":2}}`,
  `{"x":""}`, `[]`, `"str"`, `5`, `null`, `not json`, ``, `{}`, `{"a":"","b":""}`, `{"b":null,"a":""}`,
];
const tools = ["Read", "Subagent", "Agent", "Other"];
const schemas = [null, schemaA, schemaNoRequired, schemaWeird, [], "s"];
const stripString = [];
for (const a of args) for (const tool of tools) for (const schema of schemas) {
  const out = m.stripEmptyOptionalToolArgs(a, tool, schema === null ? undefined : schema);
  if (typeof out === "string") stripString.push([a, tool, schema, out]);
}
const objects = [
  { path: "", pages: "", mode: "fast", extra: [] }, { note: null, flag: null, path: null }, { a: "", b: "", c: "keep" }, {}, { x: null },
];
const stripObject = [];
for (const o of objects) for (const tool of tools) for (const schema of schemas) {
  const out = m.stripEmptyOptionalToolArgs(o, tool, schema === null ? undefined : schema);
  stripObject.push([o, tool, schema, JSON.parse(JSON.stringify(out))]);
}
const indexInputs = [0, 1, 5, -1, 1.5, "3", " 4 ", "", "abc", null, true, false, "1e2", "+5", "5.", "-0", NaN === 1 ? 0 : 7, "Infinity", 9007199254740991];
const failures = [
  [{}, undefined], [null, undefined], ["str", undefined],
  [{ error: { code: "rate_limit_exceeded", message: "slow down" } }, undefined],
  [{ error: { code: "rate_limited" } }, undefined],
  [{ error: { code: "context_length_exceeded", message: "too long" } }, undefined],
  [{ response: { error: { code: "x", message: "resp err" } }, error: { code: "ignored" } }, "custom_type"],
  [{ response: { error: "not object" }, error: { code: "root_code", message: "root msg" } }, undefined],
  [{ response: null, message: "plain" }, undefined],
  [{ error: { code: 5, message: 6 }, message: "fallback msg" }, undefined],
  [{ response: { error: [1] }, error: { code: "root" } }, undefined],
  [{ error: {} }, "other_type"],
  [[], undefined],
];
const failure = failures.map(([d, t]) => [d, t ?? "server_error", m.normalizeUpstreamFailure(d, t)]);
const summaries = [
  { summary: [{ text: "a" }, { text: "" }, { text: "b" }, null, 5, { text: 7 }, {}] }, { summary: [] }, { summary: "no" }, {}, null, "str",
  { summary: [{ text: "only" }] },
];
const names = ["  Read ", "Agent", 5, null, undefined, "", " \t x \n"];
const out = {
  strip_string: stripString,
  strip_object: stripObject,
  index: indexInputs.map((v) => [v, m.normalizeOutputIndex(v)]),
  failure,
  summary: summaries.map((s) => [s, m.extractResponsesReasoningSummaryText(s)]),
  name: names.map((n) => [n === undefined ? null : n, m.normalizeToolName(n)]),
};
writeFileSync(process.argv[3], JSON.stringify(out));
console.log("ok", stripString.length, stripObject.length, out.index.length, failure.length);
