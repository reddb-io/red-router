// Normalize decision answers returned by System One gateways. The live transport
// and stored-connection policy are owned by systemOneCore and jevRouting.

type JsonRecord = Record<string, unknown>;

/** Resellers sometimes omit confidence; the winning probability stands in. */
export function normalizeAnswers(answers: JsonRecord | null | undefined): JsonRecord {
  const out: JsonRecord = {};
  for (const [name, answer] of Object.entries(answers || {})) {
    if (!answer || typeof answer !== "object" || Array.isArray(answer)) continue;
    const a = answer as JsonRecord;
    if (a.type === "noul") {
      const value = Number(a.noul);
      out[name] = {
        type: "noul",
        noul: Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0,
      };
      continue;
    }
    const probabilities: JsonRecord = {};
    for (const [option, value] of Object.entries((a.probabilities as JsonRecord) || {})) {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1) {
        probabilities[option] = value;
      }
    }
    const probs = Object.values(probabilities) as number[];
    const confidence =
      typeof a.confidence === "number" ? a.confidence : probs.length ? Math.max(...probs) : 0;
    out[name] = { ...a, probabilities, confidence };
  }
  return out;
}
