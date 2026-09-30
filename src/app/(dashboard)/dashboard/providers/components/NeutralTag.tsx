import type { ReactNode } from "react";
import { cn } from "@/shared/utils";

/**
 * The one label style used for category, auth-type and "Free" markers on the providers
 * dashboard. Deliberately neutral: a label names something, it does not signal state, so it
 * never carries a hue. State (connected, warning, error) is shown with the feedback roles.
 */
export const NEUTRAL_TAG_CLASS =
  "inline-flex shrink-0 items-center rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium leading-none whitespace-nowrap text-text-muted";

export function NeutralTag({
  children,
  title,
  className,
  "data-testid": testId,
}: {
  children: ReactNode;
  title?: string;
  className?: string;
  "data-testid"?: string;
}) {
  return (
    <span className={cn(NEUTRAL_TAG_CLASS, className)} title={title} data-testid={testId}>
      {children}
    </span>
  );
}
