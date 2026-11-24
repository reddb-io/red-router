/** Static audit of the pinned executor registry; never imports historical code. */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import ts from "typescript";

const baseline = "525a71de4ac25968d0a25e52eeb1b09cc21c6e92";
const sourcePath = "open-sse/executors/index.ts";
const source = ts.createSourceFile(
  sourcePath,
  execFileSync("git", ["show", `${baseline}:${sourcePath}`], { encoding: "utf8" }),
  ts.ScriptTarget.Latest,
  true
);
let table: ts.ObjectLiteralExpression | undefined;
function find(node: ts.Node) {
  if (
    ts.isVariableDeclaration(node) &&
    node.name.getText(source) === "lazyExecutors" &&
    node.initializer &&
    ts.isObjectLiteralExpression(node.initializer)
  )
    table = node.initializer;
  ts.forEachChild(node, find);
}
find(source);
if (!table) throw new Error("Pinned executor registry was not found");
const rows = table.properties.map((property) => {
  if (!ts.isPropertyAssignment(property)) throw new Error("Unrecognized executor registration");
  const alias = ts.isStringLiteral(property.name)
    ? property.name.text
    : property.name.getText(source);
  const imports: string[] = [];
  function inspect(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      imports.push(node.arguments[0].text.replace("./", "open-sse/executors/"));
    ts.forEachChild(node, inspect);
  }
  inspect(property.initializer);
  if (!imports.length) throw new Error(`No source module for ${alias}`);
  return {
    alias,
    imports,
    line: source.getLineAndCharacterOfPosition(property.getStart(source)).line + 1,
  };
});
const groups = new Map<string, typeof rows>();
for (const row of rows) {
  const key = row.imports.join(", ");
  groups.set(key, [...(groups.get(key) ?? []), row]);
}
const partial: Record<string, string> = {
  "open-sse/executors/antigravity.ts":
    "Partial: native Antigravity translation/session/quota/refresh exists. Compare fallback, output cap and stream contracts.",
  "open-sse/executors/codex.ts":
    "Partial: Responses transport and Codex session/refresh exist. App-server is a separate registration below.",
  "open-sse/executors/github.ts":
    "Partial: Copilot refresh and request headers exist. Verify model discovery, account restrictions and fallback.",
  "open-sse/executors/xai.ts":
    "Partial: fixed API endpoint and xai-oauth refresh exist. Verify CLI tool/reasoning and error contracts.",
  "open-sse/executors/moonshot.ts":
    "Partial: fixed compatible API endpoint exists. Native executor normalization is not certified.",
};
const groupRows = [...groups]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([modules, aliases]) => {
    const complex = /web|app-server|cursor|windsurf|kiro|devin|promptql|trae|uc\.ts|maxai/.test(
      modules
    );
    return {
      aliases: aliases.map((entry) => entry.alias),
      modules: aliases[0].imports,
      sourceLine: aliases[0].line,
      complexity: complex ? "XL" : "L",
      status:
        partial[modules] ??
        "Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient.",
    };
  });
const report = {
  baseline,
  sourcePath,
  aliasCount: rows.length,
  executorGroups: groupRows.length,
  note: "Registry presence is not proof of availability. Check retirement/feature flags and supported provider integrations before implementing. No executor is marked complete by this static audit.",
  groups: groupRows,
};
writeFileSync(
  "config/upstream/legacy-executor-parity.json",
  JSON.stringify(report, null, 2) + "\n"
);
const lines = groupRows
  .map(
    (row) =>
      `| ${row.complexity} | ${row.aliases.map((alias) => `\`${alias}\``).join(", ")} | ${row.modules.map((module) => `\`${module}\``).join(", ")} | ${row.status} |`
  )
  .join("\n");
writeFileSync(
  "docs/architecture/LEGACY_EXECUTOR_PARITY.md",
  `# Provider executor parity audit\n\nPinned baseline: \`${baseline}\`. Generated from \`${sourcePath}\` with \`node --import tsx/esm scripts/research/legacy-executor-parity.ts\`.\n\n${rows.length} explicit aliases form ${groupRows.length} source-module groups. Aliases are not distinct provider implementations. Default compatible providers and external search registries are outside this table. The full module inventory remains in [legacy-rust-parity.json](../../config/upstream/legacy-rust-parity.json).\n\n${report.note} Keep Gemini CLI retired. Follow supported CLI integrations; do not port client impersonation, challenge evasion or credential sharing as a reliability strategy. Web-session executors need explicit availability and supported-integration review, not automatic restoration merely because source exists.\n\nNative evidence: \`rust/red-routerd/src/control_plane.rs\`, \`lib.rs\`, \`product_provider.rs\`, protocol/stream modules and \`legacy_providers.rs\`. Native OAuth supports six configured kinds (Codex, Claude, Antigravity, GitHub, xAI, Openference); this is independent of the number of catalog providers. Claude OAuth is handled outside the lazy registry and remains in CORE-04/PV-24.\n\nFixed compatible chat endpoints currently cover OpenAI, OpenRouter, Groq, Cerebras, SambaNova, Mistral, DeepSeek, Together, Perplexity, Fireworks, xAI, NVIDIA, AI21, Moonshot/Kimi, SiliconFlow and Novita. This does not certify protocol quirks, model aliases, native metadata, quota behavior or every old setting for those providers.\n\n## Explicit legacy registrations\n\nComplexity is an initial estimate, independent of priority. L = provider/protocol integration; XL = additional process, browser, event-stream or stateful transport. Prioritize API-04 and CORE-04 operational use cases using the [full backlog](LEGACY_RUST_PARITY_BACKLOG.md) and [configuration gaps](LEGACY_PROVIDER_PARITY_FIELDS.md).\n\n| Complexity | Registered aliases | Pinned source | Native parity evidence / remaining work |\n| --- | --- | --- | --- |\n${lines}\n\nEach acceptance row must link authorization/session lifecycle, endpoint/model mapping, request/response fixtures, streaming cancellation/errors, quota/account attribution, SQLite migration and SPA configuration. A catalog listing, successful generic chat request or presence of a name in source does not close a row.\n`
);
console.log(JSON.stringify({ aliases: rows.length, executorGroups: groupRows.length }));
