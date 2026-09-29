"use client";

import { ChevronDown, CircleAlert } from "lucide-react";
import Icon from "@/shared/components/Icon";
import { useId } from "react";
import { useTranslations } from "next-intl";
import { cn } from "@/shared/utils/cn";
import { select } from "@/shared/design-system/contracts/select.variants";

interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "size"> {
  label?: React.ReactNode;
  options?: SelectOption[];
  placeholder?: string;
  error?: React.ReactNode;
  hint?: React.ReactNode;
  selectClassName?: string;
  /** Keep the placeholder selectable after a real value is chosen. */
  placeholderDisabled?: boolean;
}

export default function Select({
  label,
  options = [],
  value,
  onChange,
  placeholder,
  error,
  hint,
  disabled = false,
  required = false,
  className,
  selectClassName,
  placeholderDisabled = true,
  id: externalId,
  children,
  ...props
}: SelectProps) {
  const t = useTranslations("common");
  const generatedId = useId();
  const selectId = externalId || generatedId;
  const errorId = error ? `${selectId}-error` : undefined;
  const hintId = hint && !error ? `${selectId}-hint` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(" ") || undefined;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && (
        <label htmlFor={selectId} className="text-sm font-medium text-text-main">
          {label}
          {required && (
            <span className="text-feedback-danger-foreground ml-1" aria-hidden="true">
              *
            </span>
          )}
        </label>
      )}
      <div className="relative">
        <select
          id={selectId}
          value={value}
          onChange={onChange}
          disabled={disabled}
          required={required}
          aria-required={required || undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={select({
            class: [
              // design.md: 44px targets on touch; iOS zooms into fields under 16px
              "appearance-none pe-10 pointer-coarse:min-h-11 transition-[border-color,box-shadow,opacity] duration-150",
              "text-[16px] sm:text-sm",
              selectClassName,
            ],
          })}
          {...props}
        >
          {!children && (placeholder ?? t("selectOption")) && (
            <option value="" disabled={placeholderDisabled} className="bg-surface text-text-muted">
              {placeholder ?? t("selectOption")}
            </option>
          )}
          {!children &&
            options.map((option) => (
              <option key={option.value} value={option.value} className="bg-surface text-text-main">
                {option.label}
              </option>
            ))}
          {children}
        </select>
        <div
          className="absolute inset-y-0 end-0 flex items-center pe-3 pointer-events-none text-text-muted"
          aria-hidden="true"
        >
          <Icon icon={ChevronDown} size="lg" color="current" />
        </div>
      </div>
      {error && (
        <p
          id={errorId}
          className="text-xs text-feedback-danger-foreground flex items-center gap-1"
          role="alert"
        >
          <Icon icon={CircleAlert} size="sm" color="current" />
          {error}
        </p>
      )}
      {hint && !error && (
        <p id={hintId} className="text-xs text-text-muted">
          {hint}
        </p>
      )}
    </div>
  );
}
