"use client";

import DecisionRouterCard from "@/shared/components/DecisionRouterCard";
import ReasoningAutopilotCard from "@/shared/components/ReasoningAutopilotCard";
import { translate } from "@/i18n/runtime";

// Autopilot: two choices a small decision model (JEV) can make on each turn.
// Global settings (admin-only while resource scoping is on).
export default function AutopilotPage() {
  return (
    <div className="flex flex-col gap-6">
      <p className="max-w-3xl text-sm text-text-muted">
        {translate("Both start Off. Use Test run first: it decides and logs what it would have done (Usage → Details) without changing any request, so you can judge it before turning it On.")}
      </p>
      <DecisionRouterCard />
      <ReasoningAutopilotCard />
    </div>
  );
}
