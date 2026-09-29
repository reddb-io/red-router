"use client";

import Icon from "@/shared/components/Icon";
import { primitiveIcon } from "@/shared/icons/primitiveIcons";
import { ArrowBigUp, CircleAlert } from "lucide-react";
import { useId, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { cn } from "@/shared/utils/cn";
import { input } from "@/shared/design-system/contracts/input.variants";

interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> {
  label?: React.ReactNode;
  error?: React.ReactNode;
  hint?: React.ReactNode;
  icon?: string;
  inputClassName?: string;
}

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
  id: externalId,
  onKeyDown: externalOnKeyDown,
  onKeyUp: externalOnKeyUp,
  ...props
}: InputProps) {
  const t = useTranslations("common");
  const generatedId = useId();
  const inputId = externalId || generatedId;
  const errorId = error ? `${inputId}-error` : undefined;
  const hintId = hint && !error ? `${inputId}-hint` : undefined;
  const capsLockId = `${inputId}-capslock`;
  const isPassword = type === "password";
  const [capsLockOn, setCapsLockOn] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);

  const detectCapsLock = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (isPassword) {
        setCapsLockOn(e.getModifierState("CapsLock"));
      }
    },
    [isPassword]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      detectCapsLock(e);
      externalOnKeyDown?.(e);
    },
    [detectCapsLock, externalOnKeyDown]
  );

  const handleKeyUp = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      detectCapsLock(e);
      externalOnKeyUp?.(e);
    },
    [detectCapsLock, externalOnKeyUp]
  );

  const showCapsLock = isPassword && capsLockOn && inputFocused;
  const describedBy =
    [errorId, showCapsLock ? capsLockId : undefined, hintId].filter(Boolean).join(" ") || undefined;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && (
        <label htmlFor={inputId} className="text-sm font-medium text-text-main">
          {label}
          {required && (
            <span className="text-feedback-danger-foreground ml-1" aria-hidden="true">
              *
            </span>
          )}
        </label>
      )}
      <div className="relative">
        {icon && (
          <div className="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none text-text-muted">
            {primitiveIcon(icon) ? (
              <Icon icon={primitiveIcon(icon)!} size="lg" color="current" />
            ) : (
              <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
                {icon}
              </span>
            )}
          </div>
        )}
        <input
          id={inputId}
          type={type}
          placeholder={placeholder}
          value={value}
          onChange={onChange}
          disabled={disabled}
          required={required}
          aria-required={required || undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          onFocus={(e) => {
            setInputFocused(true);
            props.onFocus?.(e);
          }}
          onBlur={(e) => {
            setInputFocused(false);
            setCapsLockOn(false);
            props.onBlur?.(e);
          }}
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
      {showCapsLock && (
        <p
          id={capsLockId}
          className="text-xs text-feedback-warning-foreground flex items-center gap-1 animate-in fade-in duration-200"
          role="status"
          aria-live="polite"
        >
          <Icon icon={ArrowBigUp} size="sm" color="current" />
          {t("capsLockOn")}
        </p>
      )}
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
