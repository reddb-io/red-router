"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  SIDEBAR_DEFAULT_WIDTH,
  clampSidebarWidth,
  readSidebarPanelOpen,
  readSidebarWidth,
  sidebarWidthForKey,
  writeSidebarPanelOpen,
  writeSidebarWidth,
} from "@/shared/utils/sidebarWidth";

// The stored width is only read (nothing to subscribe to) and the server snapshot is the default,
// so the server render and the first client render agree before the stored value applies.
const noopSubscribe = () => () => {};
const readStored = () => readSidebarWidth();
const readServer = () => SIDEBAR_DEFAULT_WIDTH;
const readStoredOpen = () => readSidebarPanelOpen();
const readServerOpen = () => true;

/** The side panel's width and open state: pointer drag, keyboard steps, double-click to reset, remembered. */
export function useSidebarWidth() {
  const stored = useSyncExternalStore(noopSubscribe, readStored, readServer);
  const storedOpen = useSyncExternalStore(noopSubscribe, readStoredOpen, readServerOpen);
  const [openOverride, setOpenOverride] = useState<boolean | null>(null);
  const open = openOverride ?? storedOpen;
  const setOpen = useCallback((next: boolean) => {
    setOpenOverride(next);
    writeSidebarPanelOpen(next);
  }, []);
  const [override, setOverride] = useState<number | null>(null);
  const [resizing, setResizing] = useState(false);
  const width = override ?? stored;
  const widthRef = useRef(width);
  useEffect(() => {
    widthRef.current = width;
  }, [width]);

  const commit = useCallback((next: number) => {
    const clamped = clampSidebarWidth(next);
    setOverride(clamped);
    writeSidebarWidth(clamped);
  }, []);

  const startDrag = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    const origin = event.clientX;
    const startWidth = widthRef.current;
    setResizing(true);

    const move = (moveEvent: PointerEvent) => {
      const delta = rtl ? origin - moveEvent.clientX : moveEvent.clientX - origin;
      setOverride(clampSidebarWidth(startWidth + delta));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      setResizing(false);
      writeSidebarWidth(widthRef.current);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  }, []);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
      const next = sidebarWidthForKey(widthRef.current, event.key, rtl);
      if (next === null) return;
      event.preventDefault();
      commit(next);
    },
    [commit]
  );

  const reset = useCallback(() => commit(SIDEBAR_DEFAULT_WIDTH), [commit]);

  return { width, resizing, startDrag, onKeyDown, reset, open, setOpen };
}
