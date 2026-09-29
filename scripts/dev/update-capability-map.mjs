#!/usr/bin/env node
/**
 * Records what a delivered slice changed in config/upstream/capability-map.json, so the ledger
 * stays a statement of what RedRouter does today.
 *
 *   node scripts/dev/update-capability-map.mjs <updates.json>
 *
 * updates.json: { "<capability id>": { "head": "equivalent|better|partial|missing", "headEvidence": "…" } }
 * Unknown ids fail loudly; only `head` and `headEvidence` are ever rewritten.
 */
import fs from "node:fs";

const MAP = "config/upstream/capability-map.json";
const HEADS = new Set(["equivalent", "better", "partial", "missing"]);
const updates = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const raw = fs.readFileSync(MAP, "utf8");
const map = JSON.parse(raw);
const pending = new Set(Object.keys(updates));

(function walk(node) {
  if (Array.isArray(node)) return node.forEach(walk);
  if (!node || typeof node !== "object") return;
  if (typeof node.id === "string" && "head" in node && pending.has(node.id)) {
    const update = updates[node.id];
    if (!HEADS.has(update.head)) throw new Error(`${node.id}: bad head "${update.head}"`);
    node.head = update.head;
    if (update.headEvidence) node.headEvidence = update.headEvidence;
    pending.delete(node.id);
  }
  Object.values(node).forEach(walk);
})(map);

if (pending.size > 0) throw new Error(`unknown capability ids: ${[...pending].join(", ")}`);
const indent = /^\{\n( +)"/.exec(raw)?.[1].length ?? 2;
fs.writeFileSync(MAP, `${JSON.stringify(map, null, indent)}\n`);
console.log(`updated ${Object.keys(updates).length} capabilities`);
