import { writeFileSync } from "node:fs";
const mod = await import(process.argv[2]);
const entry = mod.opencode_goProvider;
const formats = {};
for (const m of entry.models) formats[m.id] = m.targetFormat || "openai";
const counts = {};
for (const f of Object.values(formats)) counts[f] = (counts[f] || 0) + 1;
writeFileSync(process.argv[3], JSON.stringify({ baseUrl: entry.baseUrl, formats }, null, 0));
console.log(Object.keys(formats).length, JSON.stringify(counts));
