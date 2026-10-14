/**
 * Conservative admission estimate for retained JSON-like payloads. Unlike
 * JSON.stringify, this stops at the budget without allocating a second body.
 * Includes container/string overhead so many tiny deltas also exhaust a budget.
 * Infinity means unsupported, too deep, or over budget; callers must not retain it.
 */
export function estimateRetainedBytes(value: unknown, maxBytes: number): number {
  let bytes = 0;
  const seen = new Set<object>();
  const charge = (amount: number) => {
    bytes += amount;
    return bytes <= maxBytes;
  };

  const visit = (item: unknown, depth: number): boolean => {
    if (typeof item === "string") return charge(24 + item.length * 2);
    if (item === null || item === undefined) return charge(8);
    if (typeof item === "number" || typeof item === "boolean") return charge(8);
    if (typeof item !== "object" || depth > 64) return false;
    if (seen.has(item)) return true;
    seen.add(item);
    if (!charge(64)) return false;

    if (ArrayBuffer.isView(item)) return charge(item.buffer.byteLength);
    if (item instanceof ArrayBuffer) return charge(item.byteLength);
    if (item instanceof Date) return charge(8);

    if (Array.isArray(item)) {
      for (let index = 0; index < item.length; index++) {
        if (!charge(8) || !visit(item[index], depth + 1)) return false;
      }
      return true;
    }
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const record = item as Record<string, unknown>;
    for (const key in item) {
      if (!Object.hasOwn(item, key)) continue;
      if (!charge(32 + key.length * 2) || !visit(record[key], depth + 1)) return false;
    }
    return true;
  };

  try {
    return Number.isFinite(maxBytes) && maxBytes >= 0 && visit(value, 0) ? bytes : Infinity;
  } catch {
    return Infinity;
  }
}
