import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getUsageSink } from "@/lib/db/usageSinks";
import { sendUsageSinkTest } from "@/lib/usageSinks/engine";
import { testSinkSchema } from "@/lib/usageSinks/inputSchemas";
import { resolveSinkConfig } from "@/lib/usageSinks/sinkConfig";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/usage-sinks/{id}/test: send a sample delivery (marked `test: true`, id `test_<uuid>`)
 * right now, outside the outbox, through the same transport and egress guard as real deliveries.
 * Unsaved form values in the body are tested as typed; a credential left out keeps the stored one.
 * The answer has the shape of a provider connection test, so the dashboard shows it the same way.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const { id } = await params;
  const stored = getUsageSink(id);
  if (!stored) return NextResponse.json({ error: "Usage sink not found" }, { status: 404 });

  const raw = await request.json().catch(() => ({}));
  const parsed = validateBody(testSinkSchema, raw ?? {});
  if (isValidationFailure(parsed)) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const { data } = parsed;
  let sink = stored;
  if (data.config) {
    const resolved = resolveSinkConfig(stored.type, data.config, stored.config);
    if (!resolved.ok) return NextResponse.json({ valid: false, error: resolved.error });
    sink = { ...sink, config: resolved.stored };
  }
  if (data.mode) {
    sink = {
      ...sink,
      mode: data.mode,
      windowSec: data.mode === "window" ? (data.windowSec ?? sink.windowSec ?? 900) : null,
    };
  }

  const result = await sendUsageSinkTest(sink);
  return NextResponse.json({
    valid: result.ok,
    error: result.ok ? null : result.error,
    latencyMs: result.durationMs,
    probe: {
      method: sink.type === "kafka" ? "PRODUCE" : "POST",
      url: result.target,
      status: result.status,
      statusText: result.statusText,
      bytes: result.bytes,
      durationMs: result.durationMs,
      error: result.status === null ? result.error : null,
    },
    requests: [],
  });
}
