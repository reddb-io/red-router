// Resolves bare packages the legacy checkout does not have installed from the
// scratchpad's legacy-deps/node_modules.
import { registerHooks, createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
const req = createRequire(fileURLToPath(new URL("../legacy-deps/", import.meta.url)));
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (error?.code === "ERR_MODULE_NOT_FOUND" && !specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.startsWith("file:") && !specifier.startsWith("@/") && !specifier.startsWith("node:")) {
        try {
          return next(pathToFileURL(req.resolve(specifier)).href, context);
        } catch {}
      }
      throw error;
    }
  },
});
