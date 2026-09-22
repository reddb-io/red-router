import { NextResponse } from "next/server";
import { getChartData } from "@/lib/usageDb";
import { getApiKeys } from "@/lib/localDb";
import { canSee, getScopeFilter } from "@/lib/auth/resourceScope";
import { canSeeUsageRow, getUsageVisibility } from "@/lib/auth/usageScope";

const VALID_PERIODS = new Set(["today", "24h", "7d", "30d", "60d", "all"]);

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "7d";

    if (!VALID_PERIODS.has(period)) {
      return NextResponse.json({ error: "Invalid period" }, { status: 400 });
    }

    const apiKeyId = searchParams.get("apiKeyId");
    const scopeFilter = await getScopeFilter();
    const apiKeys = (await getApiKeys()).filter((key) => canSee(key, scopeFilter));
    const selectedKey = apiKeyId && apiKeyId !== "all" ? apiKeys.find((key) => key.id === apiKeyId) : null;
    if (apiKeyId && apiKeyId !== "all" && !selectedKey) {
      return NextResponse.json({ error: "Unknown API key" }, { status: 400 });
    }
    const visibility = await getUsageVisibility();
    const data = await getChartData(period, {
      apiKey: selectedKey?.key || null,
      visible: visibility ? (row) => canSeeUsageRow(row, visibility) : null,
    });
    return NextResponse.json(data);
  } catch (error) {
    console.error("[API] Failed to get chart data:", error);
    return NextResponse.json({ error: "Failed to fetch chart data" }, { status: 500 });
  }
}
