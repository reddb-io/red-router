export const PRODUCT_NAME = "RedRouter";
export const CLI_NAME = "red-router";
export const DEFAULT_PORT = 25050;
export const DEFAULT_HOST = "127.0.0.1";

export function resolvePort(env = process.env) {
  const value = env.RED_ROUTER_PORT ?? env.OMNIROUTE_PORT ?? env.PORT;
  const parsed = Number.parseInt(String(value ?? DEFAULT_PORT), 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : DEFAULT_PORT;
}

export function applyRedRouterEnvAliases(env = process.env) {
  const aliases = [
    ["RED_ROUTER_API_KEY", "OMNIROUTE_API_KEY"],
    ["RED_ROUTER_BASE_URL", "OMNIROUTE_BASE_URL"],
    ["RED_ROUTER_CONTEXT", "OMNIROUTE_CONTEXT"],
    ["RED_ROUTER_DATA_DIR", "DATA_DIR"],
    ["RED_ROUTER_PORT", "OMNIROUTE_PORT"],
    ["RED_ROUTER_SERVER_HOST", "OMNIROUTE_SERVER_HOST"],
  ];
  for (const [canonical, inherited] of aliases) {
    if (env[canonical] && !env[inherited]) env[inherited] = env[canonical];
  }
  return env;
}
