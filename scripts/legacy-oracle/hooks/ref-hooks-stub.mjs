import { registerHooks } from "node:module";
const stub = new URL("./request-defaults-stub.mjs", import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@/lib/providers/requestDefaults") return next(stub, context);
    return next(specifier, context);
  },
});
