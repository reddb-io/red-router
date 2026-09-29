"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { CardSkeleton } from "@/shared/components";
import RouteExplainabilityTab from "../RouteExplainabilityTab";

function RouteTraceContent() {
  const id = useSearchParams().get("id") || "";
  return <RouteExplainabilityTab initialRequestId={id} />;
}

export default function AnalyticsRouteTracePage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <RouteTraceContent />
    </Suspense>
  );
}
