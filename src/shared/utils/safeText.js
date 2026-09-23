/**
 * Text for a <pre> from a stored value that may be a string, an array of content
 * blocks or any object: React cannot render objects, and the request-details page
 * crashed on responses whose content is an array (PentatonicDev cb937dd5).
 */
export function safeText(value) {
  if (value == null) return null;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
