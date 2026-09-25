// Alert's public appearance seam consumes DS-owned Feedback Roles only. The
// Theme may remap their Brand materials without changing these names or the
// component contract (ADR 0009).
import { tv, type VariantProps } from "tailwind-variants";

export const ALERT_FEEDBACK_ROLES = ["info", "success", "warning", "danger"] as const;
export type AlertFeedbackRole = (typeof ALERT_FEEDBACK_ROLES)[number];

const FEEDBACK: Record<AlertFeedbackRole, string> = {
  info:
    "border-[var(--reddb-color-feedback-info-border)] bg-[var(--reddb-color-feedback-info-surface)] text-[var(--reddb-color-feedback-info-foreground)]",
  success:
    "border-[var(--reddb-color-feedback-success-border)] bg-[var(--reddb-color-feedback-success-surface)] text-[var(--reddb-color-feedback-success-foreground)]",
  warning:
    "border-[var(--reddb-color-feedback-warning-border)] bg-[var(--reddb-color-feedback-warning-surface)] text-[var(--reddb-color-feedback-warning-foreground)]",
  danger:
    "border-[var(--reddb-color-feedback-danger-border)] bg-[var(--reddb-color-feedback-danger-surface)] text-[var(--reddb-color-feedback-danger-foreground)]",
};

export const alert = tv({
  base: [
    "rounded-md border",
    "px-[var(--reddb-spatial-inset-md)] py-[var(--reddb-spatial-inset-sm)]",
    "text-sm",
  ].join(" "),
  variants: { feedback: FEEDBACK },
});

export type AlertVariants = VariantProps<typeof alert>;
