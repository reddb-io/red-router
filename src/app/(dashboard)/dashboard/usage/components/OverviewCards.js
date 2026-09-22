"use client";

import PropTypes from "prop-types";
const fmt = (n) => new Intl.NumberFormat().format(n || 0);
const fmtCost = (n) => `$${(n || 0).toFixed(2)}`;

const METRICS = [
  { key: "requests", label: "Requests", read: (stats) => fmt(stats.totalRequests) },
  { key: "input", label: "Input", read: (stats) => fmt(stats.totalPromptTokens) },
  { key: "cached", label: "Cached", read: (stats) => fmt(stats.totalCachedTokens) },
  { key: "output", label: "Output", read: (stats) => fmt(stats.totalCompletionTokens) },
  { key: "cost", label: "Est. cost", read: (stats) => `~${fmtCost(stats.totalCost)}`, note: "Not billing" },
];

export default function OverviewCards({ stats }) {
  return (
    <dl className="usage-metric-rail" aria-label="Usage summary">
      {METRICS.map((metric) => (
        <div key={metric.key} className={`usage-metric usage-metric--${metric.key}`}>
          <dt>{metric.label}</dt>
          <dd>{metric.read(stats)}</dd>
          {metric.note ? <span>{metric.note}</span> : null}
        </div>
      ))}
    </dl>

  );
}

OverviewCards.propTypes = {
  stats: PropTypes.object.isRequired,
};
