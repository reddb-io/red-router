/** A smaller request is affordable; this 402 does not establish an empty wallet. */
export function isRequestTokenReservationFailure(
  provider: string | null,
  status: number,
  errorText: string | null
): boolean {
  if (status !== 402 || !["openrouter", "red-router"].includes(provider || "")) return false;
  const text = String(errorText || "").slice(0, 16_384);
  if (!/requires more credits, or fewer max_tokens/i.test(text)) return false;
  const match = text.match(
    /requested up to\s+([\d,]{1,20})\s+tokens,?\s+but can only afford\s+([\d,]{1,20})(?=[.\s"}]|$)/i
  );
  if (!match) return false;
  const requested = Number(match[1].replaceAll(",", ""));
  const affordable = Number(match[2].replaceAll(",", ""));
  return (
    Number.isSafeInteger(requested) &&
    Number.isSafeInteger(affordable) &&
    affordable > 0 &&
    requested > affordable
  );
}
