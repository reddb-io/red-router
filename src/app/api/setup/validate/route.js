import { NextResponse } from "next/server";
import { getApiKeys, getProviderConnectionById } from "@/lib/localDb";
import { canSee, getScopeFilter, scopeVisible } from "@/lib/auth/resourceScope";
import { testSingleConnection } from "../../providers/[id]/test/testUtils.js";

export const dynamic = "force-dynamic";

export async function POST(request) {
  try {
    const { connectionId } = await request.json();
    const scope = await getScopeFilter();
    const connection = connectionId ? await getProviderConnectionById(connectionId) : null;
    const visibleKeys = scopeVisible(await getApiKeys(), scope);
    const checks = [{ id: "server", status: "pass", message: "RedRouter server is responding." }];

    if (!connection || !canSee(connection, scope) || connection.isActive === false) {
      checks.push({ id: "provider", status: "fail", message: "Choose an active provider connection." });
    } else {
      const result = await testSingleConnection(connection.id);
      checks.push({
        id: "provider",
        status: result.valid ? "pass" : "fail",
        message: result.valid
          ? `${connection.displayName || connection.name || connection.provider} accepted the connection test.`
          : result.error || "The selected provider connection failed validation.",
      });
    }

    const hasKey = visibleKeys.some((key) => key.isActive !== false);
    checks.push({ id: "apiKey", status: hasKey ? "pass" : "fail", message: hasKey ? "An active API key is available for clients." : "Create or resume an API key." });
    const ready = checks.every((check) => check.status === "pass");
    return NextResponse.json({ status: ready ? "ready" : "action_required", checks });
  } catch (error) {
    console.error("Setup validation failed:", error?.message || error);
    return NextResponse.json({
      status: "error",
      checks: [{ id: "server", status: "fail", message: "Setup validation failed. Check the server log for details." }],
    }, { status: 500 });
  }
}
