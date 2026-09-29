/**
 * The dashboard side panel's width (the rail beside it is fixed by the design system): the limits, the
 * stored value and the step of a keyboard resize. The limits and the default follow the DS showcase.
 */

export const SIDEBAR_WIDTH_KEY = "sidebar-panel-width";
export const SIDEBAR_PANEL_OPEN_KEY = "sidebar-panel-open";
export const SIDEBAR_MIN_WIDTH = 240;
export const SIDEBAR_MAX_WIDTH = 480;
export const SIDEBAR_DEFAULT_WIDTH = 288;
export const SIDEBAR_KEYBOARD_STEP = 8;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

/** Whole pixels inside the limits; anything that is not a number is the default. */
export function clampSidebarWidth(value: unknown): number {
  const width = typeof value === "string" ? Number.parseFloat(value) : Number(value);
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The stored width, or the default when there is none (or storage is unavailable). */
export function readSidebarWidth(storage: StorageLike | null = browserStorage()): number {
  try {
    const raw = storage?.getItem(SIDEBAR_WIDTH_KEY);
    return raw === null || raw === undefined ? SIDEBAR_DEFAULT_WIDTH : clampSidebarWidth(raw);
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

export function writeSidebarWidth(
  width: number,
  storage: StorageLike | null = browserStorage()
): void {
  try {
    storage?.setItem(SIDEBAR_WIDTH_KEY, String(clampSidebarWidth(width)));
  } catch {
    // Private windows and blocked storage: the width just is not remembered.
  }
}

/** The width after a key press on the resize handle, or null when the key is not a resize key. */
export function sidebarWidthForKey(current: number, key: string, rtl = false): number | null {
  const grow = rtl ? "ArrowLeft" : "ArrowRight";
  const shrink = rtl ? "ArrowRight" : "ArrowLeft";
  if (key === grow) return clampSidebarWidth(current + SIDEBAR_KEYBOARD_STEP);
  if (key === shrink) return clampSidebarWidth(current - SIDEBAR_KEYBOARD_STEP);
  if (key === "Home") return SIDEBAR_MIN_WIDTH;
  if (key === "End") return SIDEBAR_MAX_WIDTH;
  return null;
}

/** Whether the panel next to the rail is open; open unless the operator closed it. */
export function readSidebarPanelOpen(storage: StorageLike | null = browserStorage()): boolean {
  try {
    return storage?.getItem(SIDEBAR_PANEL_OPEN_KEY) !== "false";
  } catch {
    return true;
  }
}

export function writeSidebarPanelOpen(
  open: boolean,
  storage: StorageLike | null = browserStorage()
): void {
  try {
    storage?.setItem(SIDEBAR_PANEL_OPEN_KEY, String(open));
  } catch {
    // The choice just is not remembered.
  }
}
