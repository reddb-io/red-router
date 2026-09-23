// Refresh tests/fixtures/openai/schemas.json from OpenAI's published OpenAPI spec.
// The conformance test validates RedRouter's /v1 answers against these schemas; the
// snapshot is committed so the test stays offline. Run when OpenAI changes the spec:
//   node scripts/sync-openai-schemas.mjs [spec-url-or-path]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const SOURCE = process.argv[2] || "https://raw.githubusercontent.com/openai/openai-openapi/manual_spec/openapi.yaml";
const ROOTS = [
  "ListModelsResponse", "Model", "ErrorResponse",
  "CreateChatCompletionResponse", "CreateChatCompletionStreamResponse",
  "CreateEmbeddingResponse", "Response",
];

const text = /^https?:/.test(SOURCE) ? await (await fetch(SOURCE)).text() : fs.readFileSync(SOURCE, "utf8");
const spec = parse(text, { maxAliasCount: -1 });
const all = spec.components.schemas;

// Every schema the roots reach through $ref.
const keep = new Set();
const visit = (node) => {
  if (Array.isArray(node)) return node.forEach(visit);
  if (!node || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" && typeof value === "string") {
      const name = value.replace("#/components/schemas/", "");
      if (!keep.has(name) && all[name]) { keep.add(name); visit(all[name]); }
    } else visit(value);
  }
};
for (const root of ROOTS) { keep.add(root); visit(all[root]); }

// Drop documentation-only keys to keep the snapshot small.
const strip = (node) => {
  if (Array.isArray(node)) return node.map(strip);
  if (!node || typeof node !== "object") return node;
  return Object.fromEntries(Object.entries(node)
    .filter(([k]) => !k.startsWith("x-") && k !== "description" && k !== "example" && k !== "examples" && k !== "title")
    .map(([k, v]) => [k, strip(v)]));
};
// OpenAPI 3.0's `nullable` is not JSON Schema: rewrite it so a standard validator
// reads it (`type: [t, "null"]`, or `anyOf` with null when there is no type).
const denull = (node) => {
  if (Array.isArray(node)) return node.map(denull);
  if (!node || typeof node !== "object") return node;
  const { nullable, ...rest } = node;
  const clean = Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, denull(v)]));
  if (nullable !== true) return clean;
  if (typeof clean.type === "string") {
    const out = { ...clean, type: [clean.type, "null"] };
    if (Array.isArray(out.enum) && !out.enum.includes(null)) out.enum = [...out.enum, null];
    return out;
  }
  return { anyOf: [clean, { type: "null" }] };
};

const out = {
  source: SOURCE,
  specVersion: spec.info?.version || null,
  roots: ROOTS,
  components: { schemas: Object.fromEntries([...keep].sort().map((name) => [name, denull(strip(all[name]))])) },
};
const dest = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/openai/schemas.json");
fs.writeFileSync(dest, JSON.stringify(out, null, 1) + "\n");
console.log(`${keep.size} schemas from spec ${out.specVersion} -> ${path.relative(process.cwd(), dest)}`);
