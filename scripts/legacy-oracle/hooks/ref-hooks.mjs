// Resolves the legacy "@/x" alias to src/x(.ts) under LEGACY_ROOT.
import { registerHooks } from "node:module";
import { statSync } from "node:fs";
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) {
      const base = new URL(`src/${specifier.slice(2)}`, process.env.LEGACY_ROOT);
      for (const candidate of [base.href, `${base.href}.ts`, `${base.href}/index.ts`]) {
        if (isFile(fileURLToPath(candidate))) return next(candidate, context);
      }
    }
    if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier) && context.parentURL) {
      const base = new URL(specifier, context.parentURL);
      for (const candidate of [`${base.href}.ts`, `${base.href}/index.ts`]) {
        if (isFile(fileURLToPath(candidate))) return next(candidate, context);
      }
    }
    return next(specifier, context);
  },
});
