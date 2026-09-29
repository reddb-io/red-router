import { NextResponse } from "next/server";
import { z } from "zod";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { createUsageSink, listUsageSinks, type UsageSink } from "@/lib/db/usageSinks";
import { encrypt, isEncryptionEnabled } from "@/lib/db/encryption";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { parseAndValidatePublicUrl } from "@/shared/network/outboundUrlGuard";

const schema = z.object({
  name: z.string().trim().min(1).max(200),
  type: z.literal("webhook"),
  mode: z.enum(["instant", "window"]),
  windowSec: z.union([z.literal(300), z.literal(900), z.literal(1800), z.literal(3600)]).optional(),
  url: z.url().max(2048),
  secret: z.string().min(16).max(1024),
  apiKeyIds: z.array(z.string().min(1).max(200)).max(200).optional(),
  enabled: z.boolean().optional().default(false),
});

export function usageSinkView(sink: UsageSink) {
  return {
    id: sink.id,
    name: sink.name,
    type: "webhook" as const,
    mode: sink.mode,
    windowSec: sink.windowSec,
    apiKeyIds: sink.apiKeyIds,
    url: sink.url,
    secret: "__stored__",
    enabled: sink.enabled,
    cursorId: sink.cursorId,
    nextWindowEnd: sink.nextWindowEnd,
    createdAt: sink.createdAt,
    updatedAt: sink.updatedAt,
    source: "request_cost_ledger",
    coverage: "costed-requests-only",
  };
}

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  try {
    return NextResponse.json({ sinks: listUsageSinks().map(usageSinkView) });
  } catch (error) {
    console.error("[RedRouter UsageSinks] List failed:", error);
    return NextResponse.json({ error: "Could not list usage sinks" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const body = await request.json().catch(() => null);
  const parsed = validateBody(schema, body);
  if (isValidationFailure(parsed)) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  if (!isEncryptionEnabled()) {
    return NextResponse.json(
      { error: "STORAGE_ENCRYPTION_KEY is required for usage webhooks" },
      { status: 400 }
    );
  }
  try {
    const url = parseAndValidatePublicUrl(parsed.data.url);
    if (url.protocol !== "https:") {
      return NextResponse.json({ error: "Usage webhook URL must use HTTPS" }, { status: 400 });
    }
    const secretEncrypted = encrypt(parsed.data.secret);
    if (!secretEncrypted) throw new Error("Webhook secret encryption failed");
    const sink = createUsageSink({
      name: parsed.data.name,
      url: url.toString(),
      secretEncrypted,
      mode: parsed.data.mode,
      windowSec: parsed.data.windowSec,
      apiKeyIds: parsed.data.apiKeyIds,
      enabled: parsed.data.enabled,
    });
    return NextResponse.json({ sink: usageSinkView(sink) }, { status: 201 });
  } catch {
    return NextResponse.json(
      { error: "Could not create usage sink or URL is unsafe" },
      { status: 400 }
    );
  }
}
