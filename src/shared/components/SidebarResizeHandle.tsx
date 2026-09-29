"use client";

import { useTranslations } from "next-intl";
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from "@/shared/utils/sidebarWidth";
import { cn } from "@/shared/utils/cn";

type Props = {
  width: number;
  resizing: boolean;
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
  onReset: () => void;
};

/** The draggable edge of the sidebar: pointer, arrow keys, Home/End and double-click to reset. */
export default function SidebarResizeHandle({
  width,
  resizing,
  onPointerDown,
  onKeyDown,
  onReset,
}: Props) {
  const t = useTranslations("sidebar");
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t("resizeSidebar")}
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={SIDEBAR_MAX_WIDTH}
      aria-valuenow={width}
      tabIndex={0}
      title={t("resizeSidebarHint")}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
      className={cn(
        "absolute inset-y-0 end-0 z-10 w-1.5 translate-x-1/2 cursor-col-resize touch-none",
        "bg-transparent transition-colors hover:bg-primary/40 focus-visible:bg-primary/60 focus-visible:outline-none",
        resizing && "bg-primary/60"
      )}
    />
  );
}
