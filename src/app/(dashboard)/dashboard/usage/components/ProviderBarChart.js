"use client";

import { useState, useMemo } from "react";
import PropTypes from "prop-types";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";

const COLORS = ["#6366f1", "#14b8a6", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4", "#10b981", "#f97316"];

const fmtTokens = (n) => {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n || 0);
};

export default function ProviderBarChart({ byProvider }) {
  const [viewMode, setViewMode] = useState("tokens");

  const chartData = useMemo(() => {
    if (!byProvider) return [];
    return Object.entries(byProvider)
      .map(([id, data]) => ({
        name: id,
        tokens: (data.promptTokens || 0) + (data.completionTokens || 0),
        requests: data.requests || 0,
      }))
      .filter((d) => d[viewMode] > 0)
      .sort((a, b) => b[viewMode] - a[viewMode]);
  }, [byProvider, viewMode]);

  const fmt = viewMode === "tokens" ? fmtTokens : String;
  const label = viewMode === "tokens" ? "Tokens" : "Requests";

  return (
    <section className="usage-chart" aria-labelledby="usage-provider-chart-title">
      <div className="usage-section-head">
        <div>
          <h2 id="usage-provider-chart-title">By provider</h2>
          <p>Compare traffic across active provider routes.</p>
        </div>
        <div className="usage-mode-switch" role="group" aria-label="Provider chart metric">
          <button
            type="button"
            onClick={() => setViewMode("tokens")}
            aria-pressed={viewMode === "tokens"}
          >
            Tokens
          </button>
          <button
            type="button"
            onClick={() => setViewMode("requests")}
            aria-pressed={viewMode === "requests"}
          >
            Requests
          </button>
        </div>
      </div>

      {!chartData.length ? (
        <div className="h-44 flex items-center justify-center text-text-muted text-sm">No provider usage yet</div>
      ) : (
        <ResponsiveContainer width="100%" height={180}>
          <BarChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.1} vertical={false} />
            <XAxis
              dataKey="name"
              tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.6 }}
              tickLine={false}
              axisLine={false}
              interval={0}
              tickFormatter={(v) => v.length > 10 ? v.slice(0, 10) + "…" : v}
            />
            <YAxis
              tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.5 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={fmt}
              width={44}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "var(--color-bg)",
                border: "1px solid var(--color-border)",
                borderRadius: "8px",
                fontSize: "12px",
              }}
              formatter={(value) => [fmt(value), label]}
            />
            <Bar dataKey={viewMode} radius={[4, 4, 0, 0]}>
              {chartData.map((_, i) => (
                <Cell key={i} fill={COLORS[i % COLORS.length]} fillOpacity={0.85} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </section>
  );
}

ProviderBarChart.propTypes = {
  byProvider: PropTypes.object,
};
