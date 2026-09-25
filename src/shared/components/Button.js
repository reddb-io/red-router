"use client";

import { button, buttonSpinner } from "@/shared/ds/button.variants";
import Icon from "./Icon";

// The dashboard's variant names mapped onto the DS Button contract: the DS has
// three appearances (primary / secondary / ghost) and a separate intent axis for
// feedback colors, so danger and success are primary with that intent.
const VARIANTS = {
  primary: { variant: "primary", intent: "neutral" },
  secondary: { variant: "secondary", intent: "neutral" },
  outline: { variant: "secondary", intent: "neutral" },
  ghost: { variant: "ghost", intent: "neutral" },
  danger: { variant: "primary", intent: "danger" },
  success: { variant: "primary", intent: "success" },
};

const ICON_SIZES = {
  sm: "text-[length:var(--reddb-spatial-icon-size-sm)]",
  md: "text-[length:var(--reddb-spatial-icon-size-md)]",
  lg: "text-[length:var(--reddb-spatial-icon-size-lg)]",
};

export default function Button({
  children,
  variant = "primary",
  size = "md",
  icon,
  iconRight,
  disabled = false,
  loading = false,
  fullWidth = false,
  className,
  ...props
}) {
  const appearance = VARIANTS[variant] || VARIANTS.primary;
  const iconClass = `leading-none ${ICON_SIZES[size] || ICON_SIZES.md}`;
  const spinner = buttonSpinner({ size });
  // An icon-only button used to be named by its ligature text; keep that name
  // by labelling the glyph when there is no text beside it.
  const iconLabel = (name) => (children ? undefined : name.replace(/_/g, " "));

  return (
    <button
      className={button({
        ...appearance,
        size,
        block: fullWidth,
        // DS heights under compact density are below 44px; design.md keeps 44px
        // targets for touch, so coarse pointers get the minimum height.
        class: ["cursor-pointer pointer-coarse:min-h-11", className],
      })}
      disabled={disabled || loading}
      aria-busy={loading ? "true" : undefined}
      {...props}
    >
      {loading ? (
        <svg className={spinner.root()} viewBox="0 0 24 24" aria-hidden="true">
          <circle className={spinner.track()} cx="12" cy="12" r="9" strokeWidth="3" />
          <path className={spinner.head()} d="M21 12a9 9 0 0 0-9-9" strokeWidth="3" strokeLinecap="round" />
        </svg>
      ) : icon ? (
        <Icon name={icon} className={iconClass} label={iconLabel(icon)} />
      ) : null}
      {children}
      {iconRight && !loading && (
        <Icon name={iconRight} className={iconClass} label={iconLabel(iconRight)} />
      )}
    </button>
  );
}
