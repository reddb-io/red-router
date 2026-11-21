/** Static audit only. Never invokes application code, tests, migrations, or rustify done. */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const BASE = "525a71de4ac25968d0a25e52eeb1b09cc21c6e92";
const TOOL = "bbf9ac726e4fbf511a77a4c9e818cd8fb7f9bcb7";
const root = process.cwd();
const [toolRepo, binary] = process.argv.slice(2);
if (!toolRepo || !binary)
  throw new Error(
    "Usage: node scripts/research/rustify-parity.mjs <pinned-rustify-checkout> <rustify-binary>"
  );
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).trim();
const toolGit = (...args) => execFileSync("git", args, { cwd: toolRepo, encoding: "utf8" }).trim();
if (toolGit("rev-parse", "HEAD") !== TOOL || toolGit("status", "--porcelain"))
  throw new Error("Rustify source must be the clean pinned commit");
const head = git("rev-parse", "HEAD");
const auditParent = path.join(root, ".local-data", "rustify-audit");
mkdirSync(auditParent, { recursive: true });
const audit = mkdtempSync(path.join(auditParent, `${BASE.slice(0, 8)}-${head.slice(0, 8)}-`));
const legacy = path.join(audit, "packages/legacy");
const put = (p, text) => {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, text, "utf8");
};
const hash = (data) => createHash("sha256").update(data).digest("hex");
const slash = (s) => s.replaceAll("\\", "/");
const code = /\.(?:[cm]?[jt]sx?)$/;
const testFile = (s) =>
  /(?:^|\/)(?:tests?|__tests__|__mocks__|fixtures)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(s);
const runtime = (s) => /^(?:src|open-sse|packages)\//.test(s);
const frontend = (s) =>
  /\.[jt]sx$/.test(s) ||
  /^src\/(?:app\/(?!api\/)|shared\/(?:components|hooks)|components|hooks)\//.test(s);
const tree = git("ls-tree", "-r", BASE)
  .split("\n")
  .map((line) => {
    const [meta, file] = line.split("\t");
    return { file, blob: meta.split(" ")[2], mode: meta.split(" ")[0] };
  });
const selected = tree
  .filter(({ mode }) => mode === "100644" || mode === "100755")
  .filter(
    ({ file }) =>
      (/^(?:src|open-sse|packages|tests|bin|scripts)\//.test(file) &&
        (code.test(file) || file.endsWith(".json"))) ||
      file === "tsconfig.json" ||
      file === "package.json"
  );
const batch = spawnSync("git", ["cat-file", "--batch"], {
  cwd: root,
  input: selected.map((x) => x.blob).join("\n") + "\n",
  maxBuffer: 512 * 1024 * 1024,
});
if (batch.status !== 0) throw new Error(batch.stderr.toString());
let offset = 0;
const originals = new Map();
for (const entry of selected) {
  const end = batch.stdout.indexOf(10, offset);
  const size = Number(batch.stdout.subarray(offset, end).toString().split(" ")[2]);
  const bytes = batch.stdout.subarray(end + 1, end + 1 + size);
  if (!Number.isFinite(size)) throw new Error(`Invalid blob ${entry.file}`);
  offset = end + 2 + size;
  originals.set(entry.file, bytes.toString("utf8"));
  put(path.join(legacy, entry.file), bytes);
}
console.log(`Materialized ${selected.length} pinned source/configuration files`);

// Normalize only import string literals in the disposable snapshot. Never edit live source.
const rawConfig = ts.parseConfigFileTextToJson(
  "tsconfig.json",
  originals.get("tsconfig.json")
).config;
const parsed = ts.convertCompilerOptionsFromJson(rawConfig.compilerOptions, legacy);
if (parsed.errors.length)
  throw new Error(
    ts.formatDiagnosticsWithColorAndContext(parsed.errors, {
      getCanonicalFileName: (s) => s,
      getCurrentDirectory: () => root,
      getNewLine: () => "\n",
    })
  );
// convertCompilerOptionsFromJson does not set pathsBasePath. Without it, a
// config with paths but no baseUrl resolves aliases against the wrong directory.
const options = {
  ...parsed.options,
  pathsBasePath: legacy,
  configFilePath: path.join(legacy, "tsconfig.json"),
  allowJs: true,
  noEmit: true,
};
const cache = ts.createModuleResolutionCache(legacy, (s) => s, options);
const imports = [];
const exportNames = new Map();
const dynamicImports = [];
for (const { file } of selected.filter((x) => code.test(x.file))) {
  const source = originals.get(file);
  const full = path.join(legacy, file);
  const ast = ts.createSourceFile(full, source, ts.ScriptTarget.Latest, true);
  const edits = [];
  const names = new Set();
  const visit = (node) => {
    let literal;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      literal = node.moduleSpecifier;
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      literal = node.argument.literal;
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference))
      literal = node.moduleReference.expression;
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      if (node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0]))
        literal = node.arguments[0];
      else
        dynamicImports.push({
          file,
          line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
          expression: node.getText(ast).slice(0, 180),
        });
    }
    if (literal && ts.isStringLiteralLike(literal)) {
      const spec = literal.text;
      const resolved = ts.resolveModuleName(spec, full, options, ts.sys, cache).resolvedModule;
      const target = resolved && slash(path.relative(legacy, resolved.resolvedFileName));
      const internal = target && !target.startsWith("../") && originals.has(target);
      const alias = Object.keys(options.paths || {}).some((pattern) =>
        pattern.includes("*")
          ? spec.startsWith(pattern.split("*")[0]) && spec.endsWith(pattern.split("*")[1])
          : pattern === spec
      );
      const row = {
        file,
        line: ast.getLineAndCharacterOfPosition(literal.getStart(ast)).line + 1,
        specifier: spec,
        target: internal ? target : null,
        resolution: internal
          ? "internal"
          : alias || spec.startsWith(".")
            ? "unresolved-local"
            : "external",
      };
      if (internal && !target.endsWith(".d.ts")) {
        let replacement = slash(path.relative(path.dirname(full), path.join(legacy, target)));
        if (!replacement.startsWith(".")) replacement = `./${replacement}`;
        if (replacement !== spec) {
          edits.push({
            start: literal.getStart(ast) + 1,
            end: literal.getEnd() - 1,
            value: replacement,
          });
          row.adapted = replacement;
        }
      }
      imports.push(row);
    }
    if (node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      if (node.name && ts.isIdentifier(node.name)) names.add(node.name.text);
      if (ts.isVariableStatement(node))
        for (const d of node.declarationList.declarations)
          if (ts.isIdentifier(d.name)) names.add(d.name.text);
    }
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause))
      for (const e of node.exportClause.elements) names.add(e.name.text);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  exportNames.set(file, [...names].sort());
  let adapted = source;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    adapted = adapted.slice(0, edit.start) + edit.value + adapted.slice(edit.end);
  if (edits.length) put(full, adapted);
}
console.log(
  `Adapted ${imports.filter((x) => x.adapted).length} import literals; original source blobs retained in provenance`
);

// A synthetic package supplies Rustify's monorepo ownership requirement.
put(
  path.join(legacy, "package.json"),
  JSON.stringify({ name: "@redrouter/legacy-audit", private: true }) + "\n"
);
put(
  path.join(audit, "rustify.toml"),
  `state_dir = "port"\nupstream = "refs/heads/baseline"\nroots = ["packages/legacy/src", "packages/legacy/open-sse", "packages/legacy/packages"]\npackages_dir = "packages"\nprimary_package = "@redrouter/legacy-audit"\nrust_crate = "rust/red-routerd"\nrust_crate_name = "red_routerd"\nextensions = ["ts", "tsx", "js", "jsx", "mjs", "cjs"]\ntest_markers = ["/tests/", "/test/", "/__tests__/", "/__mocks__/", "/fixtures/", ".test.", ".spec."]\nbinary_test_markers = ["/e2e/"]\n[batch]\nmax_files = 6\nmax_lines = 800\n`
);
put(
  path.join(audit, "port/mappings.toml"),
  readFileSync(path.join(toolRepo, "examples/typescript/mappings.toml"))
);
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]
  );
const rustFiles = walk(path.join(root, "rust/red-routerd/src")).filter((p) => p.endsWith(".rs"));
const rust = rustFiles.map((full) => ({
  file: slash(path.relative(root, full)),
  source: readFileSync(full, "utf8"),
}));
for (const r of rust) put(path.join(audit, r.file), r.source);
put(
  path.join(audit, "rust/red-routerd/Cargo.toml"),
  readFileSync(path.join(root, "rust/red-routerd/Cargo.toml"))
);
const runGit = (...args) =>
  execFileSync(
    "git",
    [
      "-c",
      "core.longpaths=true",
      "-c",
      "gc.auto=0",
      "-c",
      "maintenance.auto=false",
      "-c",
      "commit.gpgSign=false",
      ...args,
    ],
    { cwd: audit, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }
  );
runGit("init", "-b", "baseline");
runGit("-c", "core.autocrlf=false", "add", "packages", "rust", "port", "rustify.toml");
runGit(
  "-c",
  "user.name=RedRouter audit",
  "-c",
  "user.email=audit@localhost",
  "-c",
  "core.hooksPath=/dev/null",
  "commit",
  "-qm",
  `Read-only analysis inputs: legacy ${BASE}, current ${head}, Rustify ${TOOL}`
);
const outputs = {};
for (const command of ["graph", "status", "next", "e2e"]) {
  console.log(`Rustify ${command}`);
  const args = ["--repo", audit, command, "--json"];
  if (command === "next") args.push("--count", "100");
  const result = spawnSync(path.resolve(binary), args, {
    cwd: audit,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`Rustify ${command}: ${result.stderr || result.stdout}`);
  put(path.join(audit, `rustify-${command}.json`), result.stdout);
  outputs[command] = JSON.parse(result.stdout);
}
const unprefix = (s) => s.replace(/^packages\/legacy\//, "");
const graph = outputs.graph.files.map((f) => ({
  ...f,
  ts: unprefix(f.ts),
  deps: f.deps.map(unprefix),
  type_deps: f.type_deps.map(unprefix),
}));
const byFile = new Map(graph.map((f) => [f.ts, f]));
const expectedEdges = imports.filter((i) => byFile.has(i.file) && i.target && byFile.has(i.target));
const missingEdges = expectedEdges.filter((i) => !byFile.get(i.file).deps.includes(i.target));
const aliasExternals = graph.flatMap((f) =>
  f.externals
    .filter((x) => x.startsWith("@/") || x.startsWith("@omniroute/"))
    .map((specifier) => ({ file: f.ts, specifier }))
);
const tests = outputs.graph.tests.map((t) => ({
  ...t,
  ts: unprefix(t.ts),
  deps: t.deps.map(unprefix),
  helpers: t.helpers.map(unprefix),
}));
const testsByFile = new Map();
for (const t of tests)
  for (const f of t.deps) {
    const a = testsByFile.get(f) || [];
    a.push(t.ts);
    testsByFile.set(f, a);
  }
const normalizeSymbol = (s) => s.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
const symbolIndex = new Map();
for (const r of rust)
  for (const match of r.source.matchAll(
    /\b(?:fn|struct|enum|type|const|trait)\s+([A-Za-z_][A-Za-z0-9_]*)/g
  )) {
    const name = normalizeSymbol(match[1]);
    if (name.length < 8) continue;
    const a = symbolIndex.get(name) || new Set();
    a.add(r.file);
    symbolIndex.set(name, a);
  }
const backlog = readFileSync(
  path.join(root, "docs/architecture/LEGACY_RUST_PARITY_BACKLOG.md"),
  "utf8"
);
const features = backlog
  .split("\n")
  .filter((l) => /^\| (?:CORE|UI|API)-\d+ \|/.test(l))
  .map((line) => {
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((s) => s.trim());
    const anchors = [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    const oldPaths = anchors.filter((s) => /^(?:src|open-sse)\//.test(s));
    const candidates = rust
      .filter((r) => anchors.some((s) => s.endsWith(".rs") && r.file.endsWith(`/${s}`)))
      .map((r) => r.file);
    return {
      id: cells[0],
      priorityComplexity: cells[1],
      capability: cells[2],
      evidence: cells[3],
      remaining: cells[4] || cells[3],
      legacyAnchors: oldPaths,
      rustCandidates: candidates,
      status: "open-existing-backlog",
      acceptance:
        "Legacy behavior -> Rust API -> SQLite state -> SPA action -> behavioral CI evidence",
    };
  });
const routeInventory = JSON.parse(
  readFileSync(path.join(root, "config/upstream/legacy-rust-parity.json"), "utf8")
);
if (routeInventory.baseline !== BASE)
  throw new Error("Route inventory uses a different legacy baseline");
const providerFieldRows = readFileSync(
  path.join(root, "docs/architecture/LEGACY_PROVIDER_PARITY_FIELDS.md"),
  "utf8"
)
  .split("\n")
  .filter((l) => /^\| PV-\d+ \|/.test(l));
const findings = [
  {
    id: "QUOTA-ALIAS-01",
    priority: "P0",
    status: "static-gap-needs-regression",
    legacyFeature: "Public model aliases with per-model token quotas",
    evidence: ["rust/red-routerd/src/lib.rs:6244", "rust/red-routerd/src/native_usage.rs:743"],
    detail:
      "Dispatch passes target_model to begin_native_usage; quota lookup, ledger totals and reservations match reservation.model. A quota keyed by a distinct public alias is not checked by this path. Requested and actual model accounting, target changes and concurrent reservations need regression coverage before deployment. No fix or runtime test performed in this audit.",
  },
];
const files = tree
  .filter((x) => code.test(x.file))
  .map((entry) => {
    const f = entry.file;
    const scope = testFile(f)
      ? "reference-test"
      : f.endsWith(".d.ts")
        ? "type-declaration-reference"
        : !runtime(f) && !byFile.has(f)
          ? "outside-runtime-roots"
          : frontend(f)
            ? "frontend-or-shared-review"
            : "backend-or-shared-review";
    const evidence = [];
    for (const feature of features)
      if (feature.legacyAnchors.some((p) => f === p || (p.endsWith("/") && f.startsWith(p)))) {
        evidence.push({
          kind: "backlog-anchor",
          feature: feature.id,
          rust: feature.rustCandidates,
        });
      }
    for (const name of exportNames.get(f) || []) {
      const candidates = symbolIndex.get(normalizeSymbol(name));
      if (candidates && candidates.size <= 5)
        evidence.push({
          kind: "symbol-name-only-not-equivalence",
          symbol: name,
          rust: [...candidates].sort(),
        });
    }
    const node = byFile.get(f);
    return {
      legacy: f,
      blob: entry.blob,
      scope,
      status: evidence.some((e) => e.rust.length)
        ? "candidate-requires-behavior-review"
        : "no-candidate-found-not-proof-of-absence",
      evidence,
      graph: node
        ? {
            unit: node.unit,
            level: node.level,
            lines: node.lines,
            deps: node.deps,
            unresolved: node.unresolved,
            externals: node.externals,
          }
        : null,
      tests: testsByFile.get(f) || [],
      exports: exportNames.get(f) || [],
    };
  });
const sourceManifest = selected.map((e) => ({
  path: e.file,
  gitBlob: e.blob,
  adaptedSha256: hash(readFileSync(path.join(legacy, e.file))),
}));
const summary = {
  legacySourceFiles: files.length,
  runtimeSourceFiles: files.filter((f) => !testFile(f.legacy) && runtime(f.legacy)).length,
  rustifyGraphFiles: graph.length,
  rustifyTestFiles: tests.length,
  rustSourceFiles: rust.length,
  backendOrSharedFiles: files.filter((f) => f.scope === "backend-or-shared-review").length,
  backendWithCandidate: files.filter(
    (f) => f.scope === "backend-or-shared-review" && f.evidence.some((e) => e.rust.length)
  ).length,
  backendWithoutCandidate: files.filter(
    (f) => f.scope === "backend-or-shared-review" && !f.evidence.some((e) => e.rust.length)
  ).length,
  adaptedImports: imports.filter((i) => i.adapted).length,
  unresolvedLocalImports: imports.filter((i) => i.resolution === "unresolved-local").length,
  dynamicImportExpressions: dynamicImports.length,
  rustifyUnresolvedImports: graph.reduce((s, f) => s + f.unresolved.length, 0),
  runtimeFilesOutsideGraph: files.filter(
    (f) => runtime(f.legacy) && !testFile(f.legacy) && !f.legacy.endsWith(".d.ts") && !f.graph
  ).length,
  expectedInternalImportEdges: expectedEdges.length,
  missingInternalImportEdges: missingEdges.length,
  remainingAliasExternals: aliasExternals.length,
  openFeatureRows: features.length,
  navigation: routeInventory.counts,
  certifiedByThisAudit: 0,
};
const report = {
  schemaVersion: 1,
  baseline: BASE,
  currentCommit: head,
  rustifyCommit: TOOL,
  rustifyBinarySha256: hash(readFileSync(binary)),
  typescriptVersion: ts.version,
  methodology:
    "Static candidate mapping only. No rustify done/verified/skip/replace. Synthetic package and normalized imports are disposable analysis inputs; original Git blobs are the authoritative provenance. Name matches do not establish parity. Files without candidates require investigation, not automatic reimplementation. Frontend remains SPA. No application, test, CI, migration, or provider execution.",
  summary,
  findings,
  features,
  providerFieldRows,
  files,
  imports,
  dynamicImports,
  sourceManifest,
  missingEdges,
  aliasExternals,
  currentRustManifest: rust.map((r) => ({ path: r.file, sha256: hash(r.source) })),
  tests,
  rustifyStatus: outputs.status,
  rustifyNext: outputs.next,
  rustifyE2e: outputs.e2e,
  pages: routeInventory.pages,
  api: routeInventory.api,
};
put(path.join(root, "config/upstream/rustify-parity.json"), JSON.stringify(report, null, 2) + "\n");
const groups = new Map();
for (const f of files.filter((f) => f.scope === "backend-or-shared-review")) {
  const group = f.legacy.startsWith("src/app/api/")
    ? f.legacy.split("/").slice(0, 4).join("/")
    : f.legacy.split("/").slice(0, 3).join("/");
  const a = groups.get(group) || [];
  a.push(f);
  groups.set(group, a);
}
const groupsTable = [...groups]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(
    ([group, a]) =>
      `| ${group} | ${a.length} | ${a.filter((f) => f.evidence.some((e) => e.rust.length)).length} | ${a.filter((f) => !f.evidence.some((e) => e.rust.length)).length} |`
  )
  .join("\n");
const featureTable = features
  .map(
    (f) =>
      `| ${f.id} | ${f.priorityComplexity} | ${f.capability} | ${f.rustCandidates.map((p) => `\`${path.posix.basename(p)}\``).join(", ") || "Trace separately"} | ${f.remaining} |`
  )
  .join("\n");
const missingPages = routeInventory.pages
  .filter((p) => p.status === "missing-spa-route")
  .map((p) => `| ${p.area} | ${p.group} | \`${p.path}\` |`)
  .join("\n");
put(
  path.join(root, "docs/architecture/RUSTIFY_PARITY_AUDIT.md"),
  `# Rustify legacy-to-Rust audit\n\nFeature implementation remains paused. This is an analysis deliverable, not release acceptance.\n\n- Legacy: \`${BASE}\`\n- Current source: \`${head}\` (also record exact Rust hashes in JSON)\n- Rustify: [\`${TOOL}\`](https://github.com/ArchAstro/rustify/tree/${TOOL})\n- Reproduce: \`node scripts/research/rustify-parity.mjs <clean-pinned-rustify-checkout> <rustify-binary>\`\n- Full per-file evidence, import edits, unresolved imports, tests, graph dependencies, API routes and hashes: [rustify-parity.json](../../config/upstream/rustify-parity.json).\n\n## Interpretation\n\nRustify graph/status/next/e2e actually ran on an isolated synthetic Git repository. The adapter reads the historical tsconfig and resolves literal imports with TypeScript, rewriting only the disposable copy. No historical application code is executed. The synthetic package solves Rustify's workspace ownership requirement. Original blob IDs remain authoritative; adapted blobs must never be presented as the original provenance.\n\nThe index deliberately contains no certified ports. Existing implementations are candidate crosswalks from explicit backlog anchors and normalized exported symbol names; neither establishes behavioral equality. A missing candidate does not establish missing code. An existing Rust implementation may consolidate many legacy files. UI and shared files are included for dependency completeness but must not automatically be translated to Rust. The full tracked JS/TS file list includes tests/tooling outside runtime roots with explicit scope labels.\n\nThe graph does not fully resolve dynamic imports, non-code assets, generated files or missing dependencies. Inspect the unresolved lists before relying on batch order. The dependency-ready batches are technical ordering hints, not product priority. Our behavioral backlog remains authoritative. Rustify's process comparator does not verify SQLite contents or HTTP/SSE/browser behavior by itself. No tests, CI or application performance measurements were performed by this audit.\n\n## Counts (not completion percentages)\n\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\`\n\n## All open feature fronts\n\nRows are inherited from the manually audited backlog, enriched with existing Rust paths. They are not automatically rediscovered functional requirements. See [provider field gaps](LEGACY_PROVIDER_PARITY_FIELDS.md) and [executor gaps](LEGACY_EXECUTOR_PARITY.md) for finer contracts.\n\n| ID | Priority / complexity | Capability / state | Existing Rust candidates | Still required |\n| --- | --- | --- | --- | --- |\n${featureTable}\n\n## Every missing SPA navigation surface\n\n| Area | Group | Historical route |\n| --- | --- | --- |\n${missingPages}\n\n## Backend and shared module groups\n\nCandidate means investigation evidence only. The JSON enumerates every file, dependency, historical test and candidate.\n\n| Legacy group | Files | With Rust candidates | Without candidates |\n| --- | ---: | ---: | ---: |\n${groupsTable}\n`
);
console.log(JSON.stringify({ audit, summary }, null, 2));
const { finishReport } = await import("./rustify-report.mjs");
finishReport(root);
