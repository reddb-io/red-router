import { tv, type VariantProps } from "tailwind-variants";

export const meter = tv({
  slots: {
    root: "flex w-full flex-col gap-[var(--reddb-spatial-gap-sm)] text-foreground",
    summary: "flex items-baseline justify-between gap-[var(--reddb-spatial-gap-md)]",
    label: "text-sm font-medium",
    value: "text-sm tabular-nums text-ink-muted",
    track: "h-2 w-full overflow-hidden rounded-full bg-muted",
    indicator: "h-full rounded-full transition-[width] motion-reduce:transition-none",
  },
  variants: {
    // What the fill means. A measurement is drawn in ink by default — it is not
    // an action, so it does not spend the Brand red (DESIGN.md, "Interactive
    // states"); a threshold reading takes its feedback role, and `primary` is
    // an explicit opt-in for the view's one emphasis.
    tone: {
      primary: { indicator: "bg-primary" },
      neutral: { indicator: "bg-foreground" },
      info: { indicator: "bg-feedback-info-foreground" },
      success: { indicator: "bg-feedback-success-foreground" },
      warning: { indicator: "bg-feedback-warning-foreground" },
      danger: { indicator: "bg-feedback-danger-foreground" },
    },
  },
  defaultVariants: { tone: "neutral" },
});

export type MeterVariants = VariantProps<typeof meter>;
export type MeterTone = NonNullable<MeterVariants["tone"]>;
export const METER_TONES = [
  "primary",
  "neutral",
  "info",
  "success",
  "warning",
  "danger",
] as const satisfies readonly MeterTone[];
