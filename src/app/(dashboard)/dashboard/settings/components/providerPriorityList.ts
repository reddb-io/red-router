/**
 * Pure helpers behind the provider priority editor: an ordered list of provider ids where the
 * first is tried first, plus the providers not in the list yet (they follow it).
 */

export function moveItem(list: readonly string[], index: number, delta: -1 | 1): string[] {
  const target = index + delta;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) return [...list];
  const next = [...list];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function removeItem(list: readonly string[], id: string): string[] {
  return list.filter((item) => item !== id);
}

export function addItem(list: readonly string[], id: string): string[] {
  return list.includes(id) ? [...list] : [...list, id];
}

export interface ProviderOption {
  id: string;
  name: string;
  connections: number;
}

/** The providers that have connections but are not in the order yet, by name. */
export function unlisted(
  providers: readonly ProviderOption[],
  order: readonly string[]
): ProviderOption[] {
  const listed = new Set(order);
  return providers
    .filter((provider) => !listed.has(provider.id))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}
