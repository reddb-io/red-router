"use client";

import { button, buttonSpinner } from "@/shared/design-system/contracts/button.variants";
import type { ButtonIntent, ButtonVariant as DsButtonVariant } from "@/shared/design-system/contracts/button.variants";

// The dashboard's variant names mapped onto the DS Button contract: the DS has three
// appearances (primary / secondary / ghost) and a separate intent axis for feedback
// colors, so danger, success and warning are primary with that intent. `accent` has no DS
// counterpart and renders as the primary action.
const VARIANTS = {
  primary: { variant: "primary", intent: "neutral" },
  accent: { variant: "primary", intent: "neutral" },
  secondary: { variant: "secondary", intent: "neutral" },
  outline: { variant: "secondary", intent: "neutral" },
  ghost: { variant: "ghost", intent: "neutral" },
  warning: { variant: "primary", intent: "warning" },
  danger: { variant: "primary", intent: "danger" },
  success: { variant: "primary", intent: "success" },
} as const satisfies Record<string, { variant: DsButtonVariant; intent: ButtonIntent }>;

export type ButtonVariant = keyof typeof VARIANTS;

// The explicit `length:` hint keeps tailwind-merge from reading a bare
// `text-[var(...)]` as a colour and dropping it.
const ICON_SIZES = {
  sm: "text-[length:var(--reddb-spatial-icon-size-sm)]",
  md: "text-[length:var(--reddb-spatial-icon-size-md)]",
  lg: "text-[length:var(--reddb-spatial-icon-size-lg)]",
} as const;

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children?: React.ReactNode;
  variant?: ButtonVariant;
  size?: keyof typeof ICON_SIZES;
  icon?: string;
  iconRight?: string;
  loading?: boolean;
  fullWidth?: boolean;
  className?: string;
}

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
}: ButtonProps) {
  const appearance = VARIANTS[variant] ?? VARIANTS.primary;
  const iconClass = `material-symbols-outlined leading-none pointer-events-none ${ICON_SIZES[size] ?? ICON_SIZES.md}`;
  const spinner = buttonSpinner({ size });

  return (
    <button
      type="button"
      className={button({
        ...appearance,
        size,
        block: fullWidth,
        // DS heights under compact density fall below 44px; design.md keeps 44px targets
        // for touch, so coarse pointers get the minimum height.
        class: ["cursor-pointer pointer-coarse:min-h-11", className],
      })}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? (
        <svg className={spinner.root()} viewBox="0 0 24 24" aria-hidden="true">
          <circle className={spinner.track()} cx="12" cy="12" r="9" strokeWidth="3" />
          <path
            className={spinner.head()}
            d="M21 12a9 9 0 0 0-9-9"
            strokeWidth="3"
            strokeLinecap="round"
          />
        </svg>
      ) : icon ? (
        <span className={iconClass} aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {children}
      {iconRight && !loading && (
        <span className={iconClass} aria-hidden="true">
          {iconRight}
        </span>
      )}
    </button>
  );
}
