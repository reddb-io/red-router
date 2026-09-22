import { describe, expect, it, vi } from "vitest";
import tray from "../../cli/src/cli/tray/tray.js";

describe("cross-platform tray diagnostic action", () => {
  it("keeps actions and indexes consistent after adding Open log", async () => {
    const { buildMenuItems, MENU_INDEX, handleClick } = tray;
    for (const autostart of [true, false]) {
      const menu = buildMenuItems(25050, autostart);
      expect(menu[MENU_INDEX.LOG].title).toBe("Open log");
      expect(menu[MENU_INDEX.LOG].enabled).toBe(true);
      expect(menu[MENU_INDEX.LOG].tooltip).toMatch(/red-router\.log$/);
      expect(menu[MENU_INDEX.AUTOSTART].title).toContain("Auto-start");
      expect(menu[MENU_INDEX.QUIT].title).toBe("Quit");
      const onOpenLog = vi.fn(async () => {});
      const onOpenDashboard = vi.fn();
      await handleClick(MENU_INDEX.LOG, { onOpenLog, onOpenDashboard }, () => {});
      expect(onOpenLog).toHaveBeenCalledExactlyOnceWith();
      expect(onOpenDashboard).not.toHaveBeenCalled();
      handleClick(MENU_INDEX.DASHBOARD, { onOpenDashboard }, () => {});
      expect(onOpenDashboard).toHaveBeenCalledOnce();
    }
  });
});
