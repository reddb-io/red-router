// Module resolution for generate.mjs: the legacy "@/x" alias resolves to
// src/x(.ts) and extensionless relative imports to their .ts file, so the
// legacy bootstrap modules load under plain Node without installed packages.
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../../../../../", import.meta.url);

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) {
      const base = new URL(`src/${specifier.slice(2)}`, root);
      for (const candidate of [base.href, `${base.href}.ts`, `${base.href}/index.ts`]) {
        if (existsSync(fileURLToPath(candidate))) return next(candidate, context);
      }
    }
    if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier) && context.parentURL) {
      const base = new URL(specifier, context.parentURL);
      for (const candidate of [`${base.href}.ts`, `${base.href}/index.ts`]) {
        if (existsSync(fileURLToPath(candidate))) return next(candidate, context);
      }
    }
    return next(specifier, context);
  },
});
