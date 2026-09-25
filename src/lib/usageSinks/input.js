// Validation and redaction for the usage sinks API.
import { SINK_TYPES, SINK_MODES, WINDOW_SIZES_SEC } from "@/lib/db/repos/usageSinksRepo.js";

const cleanList = (value) => (Array.isArray(value)
  ? [...new Set(value.filter((v) => typeof v === "string" && v.trim()).map((v) => v.trim()))]
  : []);

/**
 * Validate a create (partial=false) or update (partial=true) body.
 * Returns { value } or { error }. On update, an empty or missing secret keeps the stored one.
 */
export function parseSinkInput(body, existing = null) {
  const partial = !!existing;
  const out = {};
  if (!partial || body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return { error: "Name is required" };
    out.name = name.slice(0, 80);
  }
  const type = body.type ?? existing?.type;
  if (!SINK_TYPES.includes(type)) return { error: `Type must be one of: ${SINK_TYPES.join(", ")}` };
  if (!partial) out.type = type;

  if (!partial || body.config !== undefined) {
    const url = typeof body.config?.url === "string" ? body.config.url.trim() : "";
    let parsed;
    try { parsed = new URL(url); } catch { return { error: "A valid webhook URL is required" }; }
    if (!["http:", "https:"].includes(parsed.protocol)) return { error: "Webhook URL must use HTTP or HTTPS" };
    const secret = typeof body.config?.secret === "string" ? body.config.secret.trim() : "";
    out.config = { url, secret: secret || existing?.config?.secret || "" };
  }

  const mode = body.mode ?? existing?.mode;
  if (!SINK_MODES.includes(mode)) return { error: `Mode must be one of: ${SINK_MODES.join(", ")}` };
  if (!partial || body.mode !== undefined) out.mode = mode;
  if (mode === "window") {
    const windowSec = Number(body.windowSec ?? existing?.windowSec);
    if (!WINDOW_SIZES_SEC.includes(windowSec)) return { error: `Window must be one of: ${WINDOW_SIZES_SEC.map((s) => `${s / 60}m`).join(", ")}` };
    if (!partial || body.windowSec !== undefined || body.mode !== undefined) out.windowSec = windowSec;
  } else if (!partial || body.mode !== undefined) {
    out.windowSec = null;
  }

  if (!partial || body.filter !== undefined) {
    const apiKeyIds = cleanList(body.filter?.apiKeyIds);
    const tags = cleanList(body.filter?.tags);
    out.filter = apiKeyIds.length || tags.length ? { apiKeyIds, tags } : null;
  }
  if (body.isActive !== undefined) out.isActive = body.isActive !== false;
  return { value: out };
}

/** A sink as the API returns it: the secret is never sent back. */
export function publicSink(sink, stats = null) {
  if (!sink) return null;
  const secret = sink.config?.secret || "";
  return {
    ...sink,
    config: {
      url: sink.config?.url || "",
      hasSecret: !!secret,
      secretHint: secret ? `…${secret.slice(-4)}` : null,
    },
    deliveries: stats || { pending: 0, delivered: 0, dead: 0 },
  };
}
