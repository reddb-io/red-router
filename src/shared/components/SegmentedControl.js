"use client";

import { cn } from "@/shared/utils/cn";
import Icon from "./Icon";

export default function SegmentedControl({
  options = [],
  value,
  onChange,
  size = "md",
  className,
}) {
  const sizes = {
    sm: "h-7 text-xs",
    md: "h-9 text-sm",
    lg: "h-11 text-base",
  };

  return (
    <div
      role="group"
      className={cn(
        "segmented-control inline-flex items-center p-1 rounded-md overflow-x-auto",
        "bg-surface-2",
        className
      )}
    >
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          onClick={() => onChange(option.value)}
          aria-pressed={value === option.value}
          className={cn(
            "segmented-control__button shrink-0 px-4 rounded-md font-medium",
            sizes[size],
            value === option.value
              ? "bg-surface text-text-main shadow-sm"
              : "text-text-muted hover:text-text-main"
          )}
        >
          {option.icon && (
            <Icon name={option.icon} size={16} className="mr-1.5" />
          )}
          {option.label}
        </button>
      ))}
    </div>
  );
}
