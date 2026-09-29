import { NextResponse } from "next/server";
import { z } from "zod";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { deleteUsageSink, getUsageSink, updateUsageSink } from "@/lib/db/usageSinks";
import { encrypt, isEncryptionEnabled } from "@/lib/db/encryption";
import { listUsageDeliveries } from "@/lib/db/usageSinks";
import { usageSinkView } from "../route";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { parseAndValidatePublicUrl } from "@/shared/network/outboundUrlGuard";

const schema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    url: z.url().max(2048).optional(),
    secret: z.string().min(16).max(1024).optional(),
    enabled: z.boolean().optional(),
    apiKeyIds: z.array(z.string().min(1).max(200)).max(200).optional(),
  })
  .strict();

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: RouteContext) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const { id } = await params;
  const sink = getUsageSink(id);
  if (!sink) return NextResponse.json({ error: "Usage sink not found" }, { status: 404 });
  return NextResponse.json({ sink: usageSinkView(sink), deliveries: listUsageDeliveries(id) });
}

export async function PATCH(request: Request, { params }: RouteContext) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const { id } = await params;
  if (!getUsageSink(id))
    return NextResponse.json({ error: "Usage sink not found" }, { status: 404 });
  const parsed = validateBody(schema, await request.json().catch(() => null));
  if (isValidationFailure(parsed))
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  try {
    if (parsed.data.secret && !isEncryptionEnabled()) {
      return NextResponse.json({ error: "STORAGE_ENCRYPTION_KEY is required" }, { status: 400 });
    }
    const url = parsed.data.url ? parseAndValidatePublicUrl(parsed.data.url) : null;
    if (url && url.protocol !== "https:") {
      return NextResponse.json({ error: "Usage webhook URL must use HTTPS" }, { status: 400 });
    }
    const sink = updateUsageSink(id, {
      name: parsed.data.name,
      url: url?.toString(),
      secretEncrypted: parsed.data.secret ? (encrypt(parsed.data.secret) ?? undefined) : undefined,
      enabled: parsed.data.enabled,
      apiKeyIds: parsed.data.apiKeyIds,
    });
    return NextResponse.json({ sink: usageSinkView(sink!) });
  } catch {
    return NextResponse.json(
      { error: "Could not update usage sink or URL is unsafe" },
      { status: 400 }
    );
  }
}

export async function DELETE(request: Request, { params }: RouteContext) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const { id } = await params;
  if (!deleteUsageSink(id))
    return NextResponse.json({ error: "Usage sink not found" }, { status: 404 });
  return NextResponse.json({ deleted: true });
}
