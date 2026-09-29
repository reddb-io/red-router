import { NextResponse } from "next/server";
import { z } from "zod";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getApiKeys } from "@/lib/db/apiKeys";
import { getProviderConnectionById } from "@/lib/db/providers";
import { buildSetupReadiness } from "@/lib/setup/readiness";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { testSingleConnection } from "../../providers/[id]/test/route";

const schema = z.object({ connectionId: z.string().min(1).max(200) });

/** Validate the same server/provider/key readiness contract used by Friday's setup workbench. */
export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const body = await request.json().catch(() => null);
  const validation = validateBody(schema, body);
  if (isValidationFailure(validation)) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  try {
    const connection = await getProviderConnectionById(validation.data.connectionId);
    const active = Boolean(connection && connection.isActive !== false);
    const [keys, result] = await Promise.all([
      getApiKeys(),
      active ? testSingleConnection(validation.data.connectionId) : Promise.resolve(null),
    ]);
    return NextResponse.json(
      buildSetupReadiness({
        connectionName: connection?.displayName || connection?.name || connection?.provider,
        connectionActive: active,
        providerValid: result?.valid === true && result?.skipped !== true,
        // Do not echo upstream error text or diagnostics into the dashboard.
        providerError: result?.skipped
          ? "Connection test was deferred; try again after the active session ends."
          : null,
        hasActiveKey: keys.some((key) => key.isActive !== false && key.isBanned !== true),
      })
    );
  } catch (error) {
    console.error("[RedRouter Setup] Validation failed:", error);
    return NextResponse.json({ error: "Setup validation failed." }, { status: 500 });
  }
}
