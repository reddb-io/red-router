// Transpile the legacy .ts files with the TypeScript compiler instead of
// Node's type stripping: it elides imports only used as types and handles
// parameter properties, which the bundler-oriented legacy code relies on.
import { registerHooks, createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
const ts = createRequire(fileURLToPath(new URL("../legacy-deps/", import.meta.url)))("typescript");
registerHooks({
  load(url, context, next) {
    if (url.startsWith("file:") && url.endsWith(".ts") && !url.includes("/node_modules/")) {
      const source = readFileSync(fileURLToPath(url), "utf8");
      const { outputText } = ts.transpileModule(source, {
        fileName: fileURLToPath(url),
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false, isolatedModules: true, useDefineForClassFields: false },
      });
      return { format: "module", source: outputText, shortCircuit: true };
    }
    return next(url, context);
  },
});
