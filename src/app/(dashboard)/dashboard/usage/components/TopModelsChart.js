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
import { seriesColor } from "@/shared/utils/chartColors";


const fmtTokens = (n) => {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n || 0);
};

const truncate = (s, max = 22) => (s && s.length > max ? s.slice(0, max) + "…" : s || "");

export default function TopModelsChart({ byModel }) {
  const [viewMode, setViewMode] = useState("tokens");

  const chartData = useMemo(() => {
    if (!byModel) return [];
    return Object.values(byModel)
      .map((data) => ({
        name: truncate(data.rawModel || "Unknown"),
        tokens: (data.promptTokens || 0) + (data.completionTokens || 0),
        requests: data.requests || 0,
      }))
      .filter((d) => d[viewMode] > 0)
      .sort((a, b) => b[viewMode] - a[viewMode])
      .slice(0, 5);
  }, [byModel, viewMode]);

  const fmt = viewMode === "tokens" ? fmtTokens : String;
  const label = viewMode === "tokens" ? "Tokens" : "Requests";

  return (
    <section className="usage-chart" aria-labelledby="usage-model-chart-title">
      <div className="usage-section-head">
        <div>
          <h2 id="usage-model-chart-title">Top models</h2>
          <p>See which models carry the most traffic.</p>
        </div>
        <div className="usage-mode-switch" role="group" aria-label="Model chart metric">
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
        <div className="h-44 flex items-center justify-center text-text-muted text-sm">No model usage yet</div>
      ) : (
        <ResponsiveContainer width="100%" height={180}>
          <BarChart
            data={chartData}
            layout="vertical"
            margin={{ top: 4, right: 40, left: 4, bottom: 4 }}
          >
            <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.1} horizontal={false} />
            <XAxis
              type="number"
              tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.5 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={fmt}
            />
            <YAxis
              type="category"
              dataKey="name"
              tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.7 }}
              tickLine={false}
              axisLine={false}
              width={90}
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
            <Bar dataKey={viewMode} radius={[0, 4, 4, 0]}>
              {chartData.map((_, i) => (
                <Cell key={i} fill={seriesColor(i)} fillOpacity={0.85} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </section>
  );
}

TopModelsChart.propTypes = {
  byModel: PropTypes.object,
};
