"use client";

import { Suspense, useCallback, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { UsageStats, RequestLogger, CardSkeleton, SegmentedControl } from "@/shared/components";
import RequestDetailsTab from "./components/RequestDetailsTab";

const PERIODS = [
  { value: "today", label: "Today" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "60d", label: "60D" },
  { value: "all", label: "All" },
];

export default function UsagePage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <UsageContent />
    </Suspense>
  );
}

function UsageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [period, setPeriod] = useState("today");
  const [apiKeyId, setApiKeyId] = useState("all");
  const [apiKeyOptions, setApiKeyOptions] = useState([]);

  const handleApiKeyOptions = useCallback((options) => setApiKeyOptions(options), []);

  const tabFromUrl = searchParams.get("tab");
  const activeTab = tabFromUrl && ["overview", "logs", "details"].includes(tabFromUrl)
    ? tabFromUrl
    : "overview";

  const handleTabChange = (value) => {
    if (value === activeTab) return;
    const params = new URLSearchParams(searchParams);
    params.set("tab", value);
    router.push(`/dashboard/usage?${params.toString()}`, { scroll: false });
  };

  return (
    <div className="usage-workbench">
      <header className="usage-heading">
        <div>
          <h1>Usage</h1>
          <p>Inspect traffic, token volume, estimated cost, and individual requests.</p>
        </div>
        <span className="usage-context">Router telemetry</span>
      </header>

      <div className="usage-command-bar">
        <SegmentedControl
          options={[
            { value: "overview", label: "Overview" },
            { value: "logs", label: "Logs" },
            { value: "details", label: "Details" },
          ]}
          value={activeTab}
          onChange={handleTabChange}
          className="w-full sm:w-auto"
        />
        {activeTab === "overview" && (
          <div className="usage-filter-group">
            {apiKeyOptions.length > 0 && (
              <select
                value={apiKeyId}
                onChange={(e) => setApiKeyId(e.target.value)}
                aria-label="Filter usage by API key"
                className="usage-key-filter"
                style={{ colorScheme: "auto" }}
              >
                <option value="all">All API keys</option>
                {apiKeyOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name || "Unnamed key"}
                  </option>
                ))}
              </select>
            )}
            <SegmentedControl
              options={PERIODS}
              value={period}
              onChange={setPeriod}
              size="sm"
              className="w-full sm:w-auto"
            />
          </div>
        )}
      </div>

      {activeTab === "overview" && (
        <Suspense fallback={<CardSkeleton />}>
          <UsageStats
            period={period}
            setPeriod={setPeriod}
            hidePeriodSelector
            apiKeyId={apiKeyId}
            onApiKeyOptions={handleApiKeyOptions}
          />
        </Suspense>
      )}
      {activeTab === "logs" && <RequestLogger />}
      {activeTab === "details" && <RequestDetailsTab />}
    </div>
  );
}
