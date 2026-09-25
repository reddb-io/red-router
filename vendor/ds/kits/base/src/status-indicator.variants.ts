import { tv, type VariantProps } from "tailwind-variants";
import { ALERT_FEEDBACK_ROLES, type AlertFeedbackRole } from "./alert.variants";

export const STATUS_INDICATOR_STATUSES = ["neutral", ...ALERT_FEEDBACK_ROLES] as const;
export type StatusIndicatorStatus = "neutral" | AlertFeedbackRole;

const STATUS: Record<StatusIndicatorStatus, { mark: string }> = {
  neutral: { mark: "border-muted bg-muted" },
  info: {
    mark:
      "border-[var(--reddb-color-feedback-info-border)] bg-[var(--reddb-color-feedback-info-foreground)]",
  },
  success: {
    mark:
      "border-[var(--reddb-color-feedback-success-border)] bg-[var(--reddb-color-feedback-success-foreground)]",
  },
  warning: {
    mark:
      "border-[var(--reddb-color-feedback-warning-border)] bg-[var(--reddb-color-feedback-warning-foreground)]",
  },
  danger: {
    mark:
      "border-[var(--reddb-color-feedback-danger-border)] bg-[var(--reddb-color-feedback-danger-foreground)]",
  },
};

export const statusIndicator = tv({
  slots: {
    root: "inline-flex items-center gap-[var(--reddb-spatial-gap-sm)] text-sm text-foreground",
    mark: "size-2 shrink-0 rounded-full border",
    label: "",
  },
  variants: {
    status: STATUS,
    labelled: {
      true: { label: "" },
      false: { label: "sr-only" },
    },
  },
  defaultVariants: { status: "neutral", labelled: true },
});

export type StatusIndicatorVariants = VariantProps<typeof statusIndicator>;
