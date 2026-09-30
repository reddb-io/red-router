/**
 * Normalises the `name` shown for each catalog model so the same model reads the
 * same way whichever provider serves it.
 *
 * Providers name their models in three different styles: a plain name ("GLM 5.3"),
 * a vendor-prefixed name copied from OpenRouter ("Z.ai: GLM 5.3") and, when the
 * upstream sends no name at all, the raw id ("z-ai/glm-5.3-flash"). Clients that
 * list several providers side by side (RedCode's picker) then look inconsistent.
 * This is display-only: ids and routing never change.
 */

const ACRONYMS = new Map(
  ["gpt", "glm", "llm", "vl", "ai", "api", "ocr", "tts", "stt", "moe", "r1", "qwq", "mimo"].map(
    (word) => [word, word === "mimo" ? "MiMo" : word.toUpperCase()] as const
  )
);

// "Z.ai: GLM 5.3" -> "GLM 5.3". Only a short leading label is treated as a vendor prefix,
// so real names containing a colon ("Claude 4: Sonnet") keep their text when the label is long.
const VENDOR_PREFIX = /^[A-Za-z0-9][A-Za-z0-9.\- ]{0,23}:\s+(?=\S)/;

const ID_LIKE = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._:-]*)*$/;

function humanizeToken(token: string): string {
  const known = ACRONYMS.get(token.toLowerCase());
  if (known) return known;
  if (/^\d/.test(token)) return token;
  return token.charAt(0).toUpperCase() + token.slice(1);
}

function humanizeId(value: string): string {
  const leaf = value.slice(value.lastIndexOf("/") + 1);
  return leaf
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(humanizeToken)
    .join(" ")
    .replace(/^GPT (?=\d)/, "GPT-");
}

export function normalizeCatalogDisplayName(name: string, id?: string): string {
  const trimmed = name.trim();
  if (!trimmed) return name;
  const leaf = id ? id.slice(id.lastIndexOf("/") + 1) : "";
  if (ID_LIKE.test(trimmed) && (trimmed === id || trimmed === leaf || trimmed.includes("/"))) {
    return humanizeId(trimmed) || trimmed;
  }
  const withoutVendor = trimmed.replace(VENDOR_PREFIX, "");
  return withoutVendor || trimmed;
}

export function normalizeCatalogModelNames<T extends Record<string, unknown>>(models: T[]): T[] {
  return models.map((model) => {
    const name = typeof model.name === "string" ? model.name : "";
    if (!name) return model;
    const id = typeof model.id === "string" ? model.id : undefined;
    const next = normalizeCatalogDisplayName(name, id);
    return next === name ? model : { ...model, name: next };
  });
}
