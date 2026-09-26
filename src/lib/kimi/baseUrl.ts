/** Shared Kimi Web endpoint selection without importing the executor. */
export function getKimiWebBaseUrl(): string {
  const envUrl = process.env.KIMI_WEB_BASE_URL?.trim();
  if (envUrl) {
    return envUrl.replace(/\/+$/, "");
  }
  return "https://www.kimi.ai";
}
