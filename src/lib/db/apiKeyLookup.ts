/** Lightweight API key lookup for pickers: id and name only, searched a page at a time. */
import { getDbInstance } from "./core";

export interface ApiKeyRef {
  id: string;
  name: string;
}

const MAX_LIMIT = 50;
/** A lookup by id returns every id asked for (names for chips), up to this many. */
const MAX_IDS = 500;

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Keys whose name (or id) contains `q`, ordered by name, plus the total match count, so a picker
 * works the same with five keys or fifty thousand. The raw key is never selected.
 */
export function searchApiKeyRefs(options: { q?: string; limit?: number; offset?: number } = {}): {
  keys: ApiKeyRef[];
  total: number;
} {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 20) || 20, 1), MAX_LIMIT);
  const offset = Math.max(Math.trunc(options.offset ?? 0) || 0, 0);
  const term = String(options.q ?? "")
    .trim()
    .toLowerCase();
  const db = getDbInstance();
  const where = term ? "WHERE lower(name) LIKE ? ESCAPE '\\' OR lower(id) LIKE ? ESCAPE '\\'" : "";
  const args = term ? [`%${escapeLike(term)}%`, `%${escapeLike(term)}%`] : [];
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM api_keys ${where}`).get(...args) as { n: number }
  ).n;
  const rows = db
    .prepare(
      `SELECT id, name FROM api_keys ${where} ORDER BY name COLLATE NOCASE, id LIMIT ? OFFSET ?`
    )
    .all(...args, limit, offset) as Array<{ id: string; name: string }>;
  return { keys: rows.map((row) => ({ id: row.id, name: row.name })), total: Number(total) };
}

/** Names for a set of key ids (a sink's filter). Ids that no longer exist are simply absent. */
export function getApiKeyRefsByIds(ids: readonly string[]): ApiKeyRef[] {
  const wanted = [...new Set(ids)].slice(0, MAX_IDS);
  if (wanted.length === 0) return [];
  const marks = wanted.map(() => "?").join(", ");
  return (
    getDbInstance()
      .prepare(`SELECT id, name FROM api_keys WHERE id IN (${marks})`)
      .all(...wanted) as Array<{ id: string; name: string }>
  ).map((row) => ({ id: row.id, name: row.name }));
}
