"use client";

// Usage overview. Its sibling pages (combo health, utilization, search, evals, cache health, route
// trace) are routes of their own, listed as tabs by the menu; the old `?tab=` links land on them.
import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CardSkeleton, UsageAnalytics } from "@/shared/components";
import DiversityScoreCard from "./components/DiversityScoreCard";

const TAB_ROUTES: Record<string, string> = {
  evals: "evals",
  search: "search",
  utilization: "utilization",
  "combo-health": "combo-health",
  "cache-health": "cache-health",
  "route-trace": "route-trace",
  "route-explain": "route-trace",
};

function AnalyticsPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const legacyTab = searchParams.get("tab");
  const target = legacyTab ? TAB_ROUTES[legacyTab] : undefined;

  useEffect(() => {
    if (!target) return;
    const id = searchParams.get("id");
    router.replace(`/dashboard/analytics/${target}${id ? `?id=${encodeURIComponent(id)}` : ""}`);
  }, [target, router, searchParams]);

  if (target) return <CardSkeleton />;

  return (
    <div className="flex flex-col gap-6">
      <UsageAnalytics />
      <DiversityScoreCard />
    </div>
  );
}

export default function AnalyticsPage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <AnalyticsPageContent />
    </Suspense>
  );
}
