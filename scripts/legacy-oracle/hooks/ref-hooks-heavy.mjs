import { registerHooks } from "node:module";
const stub = new URL("./stubs-heavy.mjs", import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@/lib/logPayloads" || specifier === "@/lib/db/providers") return next(stub, context);
    return next(specifier, context);
  },
});
