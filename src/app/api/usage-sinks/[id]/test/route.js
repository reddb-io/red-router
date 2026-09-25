import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { getUsageSinkById } from "@/lib/db/repos/usageSinksRepo.js";
import { buildSamplePayload } from "@/lib/usageSinks/payload.js";
import { parseSinkInput } from "@/lib/usageSinks/input.js";
import { sendWebhook } from "@/lib/usageSinks/webhook.js";

function displayUrl(url) {
  try { const u = new URL(url); return `${u.origin}${u.pathname}`; } catch { return url || null; }
}

// POST /api/usage-sinks/{id}/test — send a sample payload (marked "test": true)
// right now, outside the outbox. Unsaved form values in the body are tested as typed.
export async function POST(request, { params }) {
  const { id } = await params;
  const stored = await getUsageSinkById(id);
  if (!stored) return NextResponse.json({ error: "Sink not found" }, { status: 404 });
  const body = await request.json().catch(() => ({}));
  let sink = stored;
  if (body && Object.keys(body).length) {
    const { value, error } = parseSinkInput(body, stored);
    if (error) return NextResponse.json({ valid: false, error });
    sink = { ...stored, ...value, config: { ...stored.config, ...(value.config || {}) } };
  }
  const result = await sendWebhook({ config: sink.config, id: `test_${uuidv4()}`, payload: buildSamplePayload(sink, `test_${uuidv4()}`) });
  // Same shape as a provider connection test, so the dashboard shows it the same way.
  return NextResponse.json({
    valid: result.ok,
    error: result.ok ? null : result.error,
    latencyMs: result.durationMs,
    probe: {
      method: "POST", url: displayUrl(result.url), status: result.status, statusText: result.statusText,
      bytes: result.bytes, durationMs: result.durationMs, error: result.status === null ? result.error : null,
    },
    requests: [],
  });
}
