/** Read-only source inventory. Route matches are clues, NEVER feature acceptance. */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";
import { resolveSpaPage, spaPageRoutes } from "../../rust-dashboard/routes.ts";

const git = (...args: string[]) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trim();
const baseline = git(
  "rev-parse",
  "--verify",
  `${process.argv[2] || "525a71de4ac25968d0a25e52eeb1b09cc21c6e92"}^{commit}`
);
const tree = git("ls-tree", "-r", "--name-only", baseline).split("\n");
const manifestPath = "src/shared/constants/sidebarNav.ts";
const source = ts.createSourceFile(
  manifestPath,
  git("show", `${baseline}:${manifestPath}`),
  ts.ScriptTarget.Latest,
  true
);
// Interpret only literal manifest data, never execute historical application code.
function literal(node: ts.Node): any {
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isIdentifier(node) && node.text === "undefined") return undefined;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(literal);
  if (ts.isObjectLiteralExpression(node))
    return Object.fromEntries(
      node.properties.map((property) => {
        if (!ts.isPropertyAssignment(property)) throw new Error("Unsupported manifest property");
        return [
          property.name.getText(source).replace(/^['"]|['"]$/g, ""),
          literal(property.initializer),
        ];
      })
    );
  if (ts.isCallExpression(node) && node.expression.getText(source) === "tab") {
    const [id, href, label, extra] = node.arguments.map(literal);
    return { id, href, label, ...extra };
  }
  throw new Error(`Unsupported manifest expression: ${node.getText(source)}`);
}
let sections: any[] = [];
function visit(node: ts.Node) {
  if (
    ts.isVariableDeclaration(node) &&
    node.name.getText(source) === "SIDEBAR_NAV_SECTIONS" &&
    node.initializer
  )
    sections = literal(node.initializer);
  ts.forEachChild(node, visit);
}
visit(source);
if (!sections.length) throw new Error("Missing baseline navigation manifest");
const pages = sections.flatMap((section) =>
  section.entries.flatMap((entry: any) =>
    entry.tabs.flatMap((tab: any) =>
      [tab, ...(tab.children || [])].map((page: any) => {
        const target = resolveSpaPage(page.href);
        return {
          area: section.id,
          group: entry.id,
          label: page.label || entry.label,
          path: page.href,
          oldSource:
            tree.find(
              (path) =>
                path.endsWith("/page.tsx") &&
                path
                  .replace(/^src\/app/, "")
                  .replace(/\/\([^/]+\)/g, "")
                  .replace(/\/page\.tsx$/, "") === page.href
            ) || null,
          spaTarget: target?.id || null,
          status: page.external
            ? "external-link-review"
            : target
              ? "partial-requires-behavior-review"
              : "missing-spa-route",
          acceptance:
            "Open: compare UI actions, API semantics, persistence, tenant isolation and behavioral tests. URL resolution alone does not count.",
        };
      })
    )
  )
);

const rust = readFileSync("rust/red-routerd/src/lib.rs", "utf8");
const routerSource = rust.slice(
  rust.indexOf("pub fn router(state:"),
  rust.indexOf("pub fn router_with_spa")
);
const rustRoutes = [...routerSource.matchAll(/\.route\(\s*"([^"]+)"/g)].map((match, index, all) => {
  const body = routerSource.slice(match.index, all[index + 1]?.index ?? routerSource.length);
  return {
    path: match[1],
    methods: [
      ...new Set(
        [...body.matchAll(/\b(get|post|put|patch|delete|head|options)\(/g)].map((value) =>
          value[1].toUpperCase()
        )
      ),
    ],
  };
});
const normalize = (path: string) =>
  path
    .replace(/\[\[?\.\.\.([^\]]+)\]\]?/g, "{*$1}")
    .replace(/\[([^\]]+)\]/g, "{$1}")
    .replace(/\{[^}]+\}/g, "{}");
const apiFiles = tree.filter((path) => /^src\/app\/api\/.*\/route\.[jt]s$/.test(path));
const declarations = git(
  "grep",
  "-n",
  "-E",
  "export.*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)",
  baseline,
  "--",
  "src/app/api"
).split("\n");
const api = apiFiles.map((file) => {
  const path = file.replace(/^src\/app/, "").replace(/\/route\.[jt]s$/, "");
  const methods = [
    ...new Set(
      declarations
        .filter((line) => line.startsWith(`${baseline}:${file}:`))
        .flatMap((line) =>
          [...line.matchAll(/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)].map(
            (match) => match[1]
          )
        )
    ),
  ];
  const candidate = rustRoutes.find((route) => normalize(route.path) === normalize(path));
  return {
    path,
    oldSource: file,
    methods,
    rustCandidate: candidate || null,
    status: candidate
      ? "same-path-requires-contract-review"
      : "no-same-path-check-remapping-or-implement",
  };
});
const modules = {
  executors: tree.filter((path) => /^open-sse\/executors\/[^/]+\.[jt]s$/.test(path)),
  providerCatalogFiles: tree.filter((path) => /^src\/shared\/constants\/providers\//.test(path)),
  dbModules: tree.filter((path) => /^src\/lib\/db\/[^/]+\.[jt]s$/.test(path)),
  migrations: tree.filter((path) => /^src\/lib\/db\/migrations\//.test(path)),
  services: tree.filter((path) => /^open-sse\/services\/[^/]+\.[jt]s$/.test(path)),
};
const counts = {
  areas: sections.length,
  navigationGroups: sections.reduce((count, section) => count + section.entries.length, 0),
  navigationSurfaces: pages.length,
  spaPages: spaPageRoutes.length,
  missingSpaRoutes: pages.filter((page) => page.status === "missing-spa-route").length,
  partialSpaRoutes: pages.filter((page) => page.status === "partial-requires-behavior-review")
    .length,
  externalLinks: pages.filter((page) => page.status === "external-link-review").length,
  oldApiRouteFiles: api.length,
  rustRegisteredPaths: rustRoutes.length,
  samePathCandidates: api.filter((route) => route.rustCandidate).length,
};
const report = {
  baseline,
  baselineDate: git("show", "-s", "--format=%cs", baseline),
  comparedTree: "working tree; use the commit containing this report to reproduce",
  note: "Static inventory only. No completed-parity percentage. API method extraction is a search aid and may require manual review of wrappers/re-exports. Remapped routes are not necessarily absent features.",
  counts,
  pages,
  api,
  rustRoutes,
  modules,
};
writeFileSync("config/upstream/legacy-rust-parity.json", JSON.stringify(report, null, 2) + "\n");
const rows = pages
  .map(
    (page) =>
      `| ${page.area} | ${page.group} / ${page.label} | \`${page.path}\` | ${page.spaTarget || "—"} | ${page.status} |`
  )
  .join("\n");
const domains = [...new Set(api.map((route) => route.path.split("/")[2]))]
  .sort()
  .map((domain) => {
    const routes = api.filter((route) => route.path.split("/")[2] === domain);
    return `| ${domain} | ${routes.length} | ${routes.filter((route) => route.rustCandidate).length} |`;
  })
  .join("\n");
writeFileSync(
  "docs/architecture/LEGACY_RUST_PARITY_INVENTORY.md",
  `# Legacy → Rust/SPA source inventory\n\nGenerated with \`node --import tsx scripts/research/legacy-rust-parity.ts\`.\n\nBaseline: \`${baseline}\` (${report.baselineDate}), the last first-parent main commit available on 2026-10-29. All comparisons use that immutable tree, not a contemporary upstream release.\n\n${report.note}\n\nThe prioritized behavioral backlog is [LEGACY_RUST_PARITY_BACKLOG.md](LEGACY_RUST_PARITY_BACKLOG.md). The complete API, executor, database and migration lists are in [legacy-rust-parity.json](../../config/upstream/legacy-rust-parity.json). This file is a route inventory, **not a release sign-off**.\n\n## Source counts\n\n\`\`\`json\n${JSON.stringify(counts, null, 2)}\n\`\`\`\n\n## Every historical navigation surface\n\nPartial means an existing page resolves the URL, not that the named functionality works. Prefix matches (providers, combos, audit) require particular care. External links have not been accepted as feature implementations.\n\n| Area | Group / page | Historical URL | Current SPA target | Audit status |\n| --- | --- | --- | --- | --- |\n${rows}\n\n## Every API domain\n\nExact normalized path matches do not prove method, authorization or payload compatibility. No match may mean a renamed Rust API. Inspect the full per-route JSON and the backlog's explicit replacements.\n\n| Historical API domain | Route files | Same-path Rust candidates |\n| --- | ---: | ---: |\n${domains}\n`
);
console.log(JSON.stringify(counts, null, 2));
