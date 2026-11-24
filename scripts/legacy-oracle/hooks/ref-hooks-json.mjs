// The legacy code imports JSON the way a bundler allows, without
// `with { type: "json" }`; serve those files as default-export modules.
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
registerHooks({
  load(url, context, next) {
    if (url.endsWith(".json") && url.startsWith("file:") && !url.includes("/node_modules/") && !url.includes("/legacy-deps/") && !context.importAttributes?.type) {
      return { format: "module", source: `export default ${readFileSync(fileURLToPath(url), "utf8")};`, shortCircuit: true };
    }
    return next(url, context);
  },
});
