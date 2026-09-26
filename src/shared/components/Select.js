"use client";

import { cn } from "@/shared/utils/cn";
import { select } from "@/shared/ds/select.variants";
<<<<<<< HEAD
import Icon from "./Icon";
||||||| e6e8d110
=======
>>>>>>> feat/ds-v2026.09

export default function Select({
  label,
  options = [],
  value,
  onChange,
  placeholder = "Select an option",
  error,
  hint,
  disabled = false,
  required = false,
  className,
  selectClassName,
  ...props
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && (
        <label className="text-sm font-medium text-text-main">
          {label}
          {required && <span className="text-feedback-danger-foreground ml-1">*</span>}
        </label>
      )}
      <div className="relative">
        <select
          value={value}
          onChange={onChange}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          className={select({
            class: [
              // design.md: 44px targets on touch; iOS zooms into fields under 16px
              "appearance-none pr-10 pointer-coarse:min-h-11 transition-[border-color,box-shadow,opacity] duration-150",
              "text-[16px] sm:text-sm",
              selectClassName,
            ],
          })}
          {...props}
        >
          <option value="" disabled>
            {placeholder}
          </option>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none text-text-muted">
          <Icon name="expand_more" size={20} />
        </div>
      </div>
      {error && (
        <p className="text-xs text-feedback-danger-foreground flex items-center gap-1">
<<<<<<< HEAD
          <Icon name="error" size={14} />
||||||| e6e8d110
        <p className="text-xs text-[var(--reddb-color-feedback-danger-foreground)] flex items-center gap-1">
          <span className="material-symbols-outlined text-[14px]">error</span>
=======
          <span className="material-symbols-outlined text-[14px]">error</span>
>>>>>>> feat/ds-v2026.09
          {error}
        </p>
      )}
      {hint && !error && (
        <p className="text-xs text-text-muted">{hint}</p>
      )}
    </div>
  );
}
