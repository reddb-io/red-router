"use client";

import { cn } from "@/shared/utils/cn";
import { input } from "@/shared/ds/input.variants";
<<<<<<< HEAD
import Icon from "./Icon";
||||||| e6e8d110
=======
>>>>>>> feat/ds-v2026.09

export default function Input({
  label,
  type = "text",
  placeholder,
  value,
  onChange,
  error,
  hint,
  icon,
  disabled = false,
  required = false,
  className,
  inputClassName,
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
        {icon && (
          <div className="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none text-text-muted">
            <Icon name={icon} size={20} />
          </div>
        )}
        <input
          type={type}
          placeholder={placeholder}
          value={value}
          onChange={onChange}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          className={input({
            class: [
              // design.md: 44px targets on touch; iOS zooms into fields under 16px
              "pointer-coarse:min-h-11 transition-[border-color,box-shadow,opacity] duration-150 ease-out",
              "text-[16px] sm:text-sm",
              icon && "pl-10",
              inputClassName,
            ],
          })}
          {...props}
        />
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
