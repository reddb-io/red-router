/** Render the already-collected static evidence; never execute product code. */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";

export function loadReport(root = process.cwd()) {
  const index = JSON.parse(
    readFileSync(path.join(root, "config/upstream/rustify-parity.json"), "utf8")
  );
  if (!index.detailArtifact) return index;
  const bytes = readFileSync(path.join(root, index.detailArtifact.path));
  if (createHash("sha256").update(bytes).digest("hex") !== index.detailArtifact.sha256)
    throw new Error("Audit detail checksum mismatch");
  return JSON.parse(gunzipSync(bytes).toString("utf8"));
}

export function finishReport(root = process.cwd()) {
  const jsonPath = path.join(root, "config/upstream/rustify-parity.json");
  const markdownPath = path.join(root, "docs/architecture/RUSTIFY_PARITY_AUDIT.md");
  const report = loadReport(root);
  const units = new Map();
  for (const file of report.files.filter((f) => f.graph)) {
    const group = units.get(file.graph.unit) || [];
    group.push(file.legacy);
    units.set(file.graph.unit, group);
  }
  report.importCycles = [...units.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([unit, files]) => ({ unit, size: files.length, files }))
    .sort((a, b) => b.size - a.size);
  report.summary.dependencyUnits = units.size;
  report.summary.importCycles = report.importCycles.length;
  report.summary.largestImportCycle = report.importCycles[0]?.size || 0;
  const sizeOrder = { S: 0, M: 1, L: 2, XL: 3 };
  report.resumeOrder = [...report.features]
    .sort((a, b) => {
      const [pa, sa] = a.priorityComplexity.split(" / ");
      const [pb, sb] = b.priorityComplexity.split(" / ");
      return pa.localeCompare(pb) || sizeOrder[sa] - sizeOrder[sb] || a.id.localeCompare(b.id);
    })
    .map((f) => f.id);
  const archive = "config/upstream/rustify-parity-detail.json.gz";
  const bytes = gzipSync(Buffer.from(JSON.stringify(report)), { level: 9 });
  writeFileSync(path.join(root, archive), bytes);
  const index = { ...report };
  for (const field of ["files", "imports", "sourceManifest", "tests", "rustifyNext"])
    delete index[field];
  index.detailArtifact = {
    path: archive,
    format: "gzip-json",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    fields: ["files", "imports", "sourceManifest", "tests", "rustifyNext"],
    note: "Archive contains the complete report, including these large fields. Use rustify-report.mjs --find <legacy-path-fragment> to inspect file mappings.",
  };
  index.unresolvedLocalImports = report.imports.filter((i) => i.resolution === "unresolved-local");
  writeFileSync(jsonPath, JSON.stringify(index, null, 2) + "\n", "utf8");
  let markdown = readFileSync(markdownPath, "utf8");
  const marker = "\n## Audit findings and resumption order\n";
  markdown = markdown.split(marker)[0];
  markdown = markdown.replace(
    /```json\n[\s\S]*?\n```/,
    `\`\`\`json\n${JSON.stringify(report.summary, null, 2)}\n\`\`\``
  );
  const cycles = report.importCycles
    .map(
      (c) =>
        `| ${c.unit} | ${c.size} | ${c.files
          .slice(0, 4)
          .map((f) => `\`${f}\``)
          .join(", ")}${c.size > 4 ? ", … (full list in JSON)" : ""} |`
    )
    .join("\n");
  const ordered = report.resumeOrder
    .map((id) => report.features.find((f) => f.id === id))
    .map((f) => `| ${f.id} | ${f.priorityComplexity} | ${f.capability} |`)
    .join("\n");
  markdown += `${marker}
The implementation remains paused. No entries have been marked ported or verified by this audit.

The readable JSON index links a SHA-256-checked gzip archive with the complete per-file crosswalk, imports, original blob provenance, historical tests and planning batches. Inspect a file with **node scripts/research/rustify-report.mjs --find src/lib/db/providers.ts**. This reads the archive only; it does not rerun Rustify or execute the application.

1. **Alias model quota gap (P0).** Dispatch passes the target model to native reservation accounting (rust/red-routerd/src/lib.rs:6244). Model quota lookup and completed/pending usage match that target (native_usage.rs:743). A quota configured for a distinct public alias is not checked on this path. Before deploying aliases, preserve both requested and actual model attribution and verify alias limits across target changes, concurrent workers, streaming, restart and settlement. This is a static finding, not a newly executed exploit or regression test. No fix was made here.
2. **Dependency cycles.** ${report.summary.importCycles} nontrivial import cycles were identified; the largest contains ${report.summary.largestImportCycle} modules. Rustify keeps cycles in one planning unit even when they exceed its batch size. These units must be decomposed by product contract when implementation resumes; they are not a directive to recreate the legacy coupling.
3. **Scope of missing candidates.** ${report.summary.backendWithoutCandidate} backend/shared files have no candidate from the current explicit-anchor/symbol search. This is an investigation queue, not proof that every file needs a new Rust implementation. ${report.summary.backendWithCandidate} files have candidates whose contracts still require review.
4. **Resolver limitations.** ${report.summary.missingInternalImportEdges} resolved internal import edges are absent from the Rustify graph; ${report.summary.remainingAliasExternals} internal alias entries remain classified as external. Review these explicit lists in JSON before using the dependency order. Nonliteral imports and generated modules remain separately listed. A CSS import and generated documentation source can be outside the code graph without being missing backend features.

### Cyclic planning units

| Rustify unit | Files | Examples |
| --- | ---: | --- |
${cycles}

### All 32 provider field groups

These are the existing field-level audit, including both implemented subsets and remaining gaps; they are not 32 wholly absent features.

| ID | Priority / complexity | Legacy feature / fields | Current gap and next acceptance |
| --- | --- | --- | --- |
${report.providerFieldRows.join("\n")}

### Resumption queue: priority first, complexity second

S → M → L → XL within each priority. Dependency order, risk and user-visible replacement needs may override this static ordering. Start with the alias quota blocker, provider configuration/import, identity/policies and cutover before optional subsystems. Keep the frontend as a SPA.

| ID | Priority / complexity | Capability / state |
| --- | --- | --- |
${ordered}

Acceptance for each row remains: historical behavior → Rust contract → SQLite effects → SPA operation → behavioral CI evidence. Include denied/error paths and concurrency where applicable. Current catalog entries, same-path routes, matching symbols and a green Rustify command are not acceptance evidence.
`;
  writeFileSync(markdownPath, markdown, "utf8");
  console.log(JSON.stringify(report.summary, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--find") {
    if (!process.argv[3]) throw new Error("--find requires a legacy path fragment");
    const report = loadReport();
    const matches = report.files.filter((f) => f.legacy.includes(process.argv[3]));
    console.log(JSON.stringify({ total: matches.length, files: matches }, null, 2));
  } else finishReport();
}
