import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const catalogPath = join(dirname(fileURLToPath(import.meta.url)), "locales", "en.json");
const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
const messages = new Map();

function flatten(value, prefix = "") {
  for (const [key, entry] of Object.entries(value)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      flatten(entry, name);
    } else if (typeof entry === "string") {
      messages.set(name, entry);
    }
  }
}

flatten(catalog);

// Compatibility helpers for callers that used to request a locale. The CLI
// always serves English, regardless of legacy environment or saved settings.
export function detectLocale() {
  return "en";
}

export function setLocale() {
  return "en";
}

export function getLocale() {
  return "en";
}

export function t(key, vars) {
  const template = messages.get(key);
  if (template === undefined) return key;
  if (!vars || Object.keys(vars).length === 0) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    vars[name] !== undefined ? String(vars[name]) : match
  );
}

export function resetForTests() {}
