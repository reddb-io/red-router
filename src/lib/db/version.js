import pkg from "../../../cli/package.json" with { type: "json" };

let cachedVersion = null;

export function getAppVersion() {
  if (cachedVersion) return cachedVersion;
  cachedVersion = pkg.version || "0.0.0";
  return cachedVersion;
}

export function timestampSlug(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
