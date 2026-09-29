import { meterTone } from "./budgetsTypes";

interface BudgetMeterProps {
  spentUsd: number;
  maxUsd: number;
  label: string;
}

// Neutral by default; feedback colour appears only past 80% (warning) and 100% (danger).
const FILL = {
  neutral: "bg-ink-muted",
  warning: "bg-feedback-warning-foreground",
  danger: "bg-feedback-danger-foreground",
} as const;

/** A thin used-of-limit meter. */
export function BudgetMeter({ spentUsd, maxUsd, label }: BudgetMeterProps) {
  const ratio = maxUsd > 0 ? Math.min(spentUsd / maxUsd, 1) : 0;
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={maxUsd}
      aria-valuenow={Math.min(spentUsd, maxUsd)}
      className="h-1 w-full min-w-24 overflow-hidden rounded-full bg-bg-subtle"
    >
      <div
        className={`h-full rounded-full ${FILL[meterTone(spentUsd, maxUsd)]}`}
        style={{ width: `${ratio * 100}%` }}
      />
    </div>
  );
}
