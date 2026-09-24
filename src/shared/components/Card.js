"use client";

import { cn } from "@/shared/utils/cn";
import { card } from "@/shared/ds/card.variants";

// Root padding follows the DS density insets. The DS Card pads its header /
// body / footer slots; this Card keeps padding on the root so existing layouts
// that style the root as a flex/grid container keep their direct children.
const PADDINGS = {
  none: "p-0",
  xs: "p-[var(--reddb-spatial-inset-sm)]",
  sm: "p-[var(--reddb-spatial-inset-md)]",
  md: "p-[var(--reddb-spatial-inset-md)]",
  lg: "p-[var(--reddb-spatial-inset-lg)]",
};

export default function Card({
  children,
  title,
  subtitle,
  icon,
  action,
  padding = "md",
  hover = false,
  elev = false,
  className,
  ...props
}) {
  const slots = card({ raised: elev });

  return (
    <div
      className={slots.root({
        class: [
          // The DS root is a flex column that clips its media; dashboard cards
          // hold menus and popovers, so they stay block-level and unclipped.
          "block overflow-visible",
          PADDINGS[padding] ?? PADDINGS.md,
          hover && "cursor-pointer transition-colors hover:border-ink-muted",
          className,
        ],
      })}
      {...props}
    >
      {(title || action) && (
        <div className="mb-[var(--reddb-spatial-gap-lg)] flex items-center justify-between gap-[var(--reddb-spatial-gap-md)]">
          <div className={slots.titleRow()}>
            {icon && (
              <span className="material-symbols-outlined shrink-0 text-[length:var(--reddb-spatial-icon-size-md)] text-ink-muted" aria-hidden="true">{icon}</span>
            )}
            <div className="flex min-w-0 flex-col gap-[var(--reddb-spatial-gap-sm)]">
              {title && <h3 className={slots.title()}>{title}</h3>}
              {subtitle && <p className={slots.description()}>{subtitle}</p>}
            </div>
          </div>
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

Card.Section = function CardSection({ children, className, ...props }) {
  return (
    <div
      className={cn(
        "py-[var(--reddb-spatial-inset-md)] border-t border-muted first:border-t-0",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
};

Card.Row = function CardRow({ children, className, ...props }) {
  return (
    <div
      className={cn(
        "p-3 -mx-3 px-3 transition-colors",
        "border-b border-muted last:border-b-0",
        "hover:bg-muted/50",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
};

Card.ListItem = function CardListItem({
  children,
  actions,
  className,
  ...props
}) {
  return (
    <div
      className={cn(
        "group flex items-center justify-between p-3 -mx-3 px-3",
        "border-b border-muted last:border-b-0",
        "hover:bg-muted/50 transition-colors",
        className
      )}
      {...props}
    >
      <div className="flex-1 min-w-0">{children}</div>
      {actions && (
        <div className="flex items-center gap-1">
          {actions}
        </div>
      )}
    </div>
  );
};
