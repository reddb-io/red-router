// Maps "@omniroute/open-sse/x" (a workspace package) to the legacy open-sse folder.
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@omniroute/open-sse/")) {
      const base = new URL(`open-sse/${specifier.slice("@omniroute/open-sse/".length)}`, process.env.LEGACY_ROOT);
      for (const candidate of [base.href, `${base.href}.ts`, `${base.href}/index.ts`]) {
        if (existsSync(fileURLToPath(candidate))) return next(candidate, context);
      }
    }
    return next(specifier, context);
  },
});
