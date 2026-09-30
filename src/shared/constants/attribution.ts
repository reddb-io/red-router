/**
 * Limits and normalisation of the request attribution values (end user and tags) shared by the
 * request stamping (`lib/usage/attribution`), the budget scopes and their validation. Pure: no
 * database or request access, so schemas and the dashboard can import it.
 *
 * Both values are supplied by API clients and are therefore untrusted: they are stripped of
 * control characters and bounded before they are stored, compared or shown.
 */

export const END_USER_MAX_LENGTH = 128;
export const TAG_MAX_LENGTH = 32;
export const TAGS_MAX_COUNT = 20;

// eslint-disable-next-line no-control-regex -- the point is to remove control characters
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

function clean(value: unknown): string {
  return typeof value === "string" ? value.replace(CONTROL_CHARACTERS, "").trim() : "";
}

/** An end-user id as stored: control characters removed, trimmed, at most 128 characters. */
export function normalizeEndUser(value: unknown): string | null {
  const cleaned = clean(value).slice(0, END_USER_MAX_LENGTH).trim();
  return cleaned === "" ? null : cleaned;
}

/** A tag as stored: control characters removed, trimmed, lowercased, at most 32 characters. */
export function normalizeTag(value: unknown): string | null {
  const cleaned = clean(value).toLowerCase().slice(0, TAG_MAX_LENGTH).trim();
  return cleaned === "" ? null : cleaned;
}

/** Normalise, drop empties, dedupe (first wins) and cap a list of tags. */
export function normalizeTags(values: Iterable<unknown>): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const tag = normalizeTag(value);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length >= TAGS_MAX_COUNT) break;
  }
  return tags;
}

/** The `tags` column of the cost ledger / call log: a JSON array, or null when there are none. */
export function serializeAttributionTags(
  tags: readonly string[] | null | undefined
): string | null {
  return tags && tags.length > 0 ? JSON.stringify(tags) : null;
}
