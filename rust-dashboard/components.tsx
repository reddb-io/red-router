import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

type ButtonVariant =
  "primary" | "accent" | "secondary" | "outline" | "ghost" | "warning" | "danger" | "success";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  loading?: boolean;
  fullWidth?: boolean;
  icon?: string;
  iconRight?: string;
}

const buttonVariant: Record<ButtonVariant, string> = {
  primary: "bg-primary text-white hover:opacity-90",
  accent: "bg-primary text-white hover:opacity-90",
  secondary: "border border-border bg-surface hover:bg-muted/50",
  outline: "border border-border bg-transparent hover:bg-muted/50",
  ghost: "bg-transparent hover:bg-muted/50",
  warning: "bg-warning text-white hover:opacity-90",
  danger: "bg-error text-white hover:opacity-90",
  success: "bg-success text-white hover:opacity-90",
};

export function Button({
  variant = "primary",
  loading = false,
  fullWidth = false,
  icon,
  iconRight,
  disabled,
  className = "",
  children,
  ...props
}: ButtonProps) {
  const iconNode = (name: string) => (
    <span className="material-symbols-outlined text-base leading-none" aria-hidden="true">
      {name}
    </span>
  );
  return (
    <button
      type="button"
      className={`inline-flex min-h-10 items-center justify-center gap-2 rounded px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${buttonVariant[variant]} ${fullWidth ? "w-full" : ""} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <span aria-hidden="true">…</span> : icon ? iconNode(icon) : null}
      {children}
      {!loading && iconRight ? iconNode(iconRight) : null}
    </button>
  );
}

type CardPadding = "none" | "xs" | "sm" | "md" | "lg";

interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  title?: ReactNode;
  subtitle?: ReactNode;
  icon?: string;
  action?: ReactNode;
  padding?: CardPadding;
  hover?: boolean;
  elev?: boolean;
}

const cardPadding: Record<CardPadding, string> = {
  none: "p-0",
  xs: "p-2",
  sm: "p-3",
  md: "p-4",
  lg: "p-6",
};

export function Card({
  title,
  subtitle,
  icon,
  action,
  padding = "md",
  hover = false,
  elev = false,
  className = "",
  children,
  ...props
}: CardProps) {
  return (
    <div
      className={`rounded border border-border bg-surface ${cardPadding[padding]} ${hover ? "transition-colors hover:border-ink-muted" : ""} ${elev ? "shadow-sm" : ""} ${className}`}
      {...props}
    >
      {title || action ? (
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-2">
            {icon ? (
              <span className="material-symbols-outlined text-base" aria-hidden="true">
                {icon}
              </span>
            ) : null}
            <div>
              {title ? <h3 className="font-semibold">{title}</h3> : null}
              {subtitle ? <p className="mt-1 text-sm text-text-muted">{subtitle}</p> : null}
            </div>
          </div>
          {action}
        </div>
      ) : null}
      {children}
    </div>
  );
}
