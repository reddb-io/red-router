import { createRawSnippet } from "svelte";
import { describe, expect, it } from "vitest";
import {
  DRAWER_SIDES,
  Drawer,
  drawer as drawerAppearance,
  type DrawerSide,
} from "./fixtures/drawer-alert-dialog-consumer";
import { classes, classesOf, render } from "./mount";

describe("the Base Drawer", () => {
  it("moves focus into the drawer and restores it after keyboard dismissal", () => {
    const root = render(Drawer, {
      triggerLabel: "Open filters",
      title: "Filters",
      children: createRawSnippet(() => ({
        render: () => '<button data-first-filter type="button">Apply filters</button>',
      })),
    });
    const trigger = root.querySelector<HTMLButtonElement>("[data-dialog-trigger]")!;
    trigger.focus();

    trigger.click();
    const dialog = root.querySelector<HTMLDialogElement>("dialog")!;
    expect(document.activeElement).toBe(root.querySelector("[data-first-filter]"));

    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("anchors its exported appearance at every requested edge", () => {
    const edgeClass: Record<DrawerSide, string> = {
      top: "top-0",
      right: "right-0",
      bottom: "bottom-0",
      left: "left-0",
    };
    expect(DRAWER_SIDES).toEqual(["top", "right", "bottom", "left"]);

    for (const side of DRAWER_SIDES) {
      const root = render(Drawer, {
        triggerLabel: `Open ${side} drawer`,
        title: `${side} drawer`,
        side,
        class: "consumer-drawer",
      });
      const element = root.querySelector("dialog")!;

      expect(classes(element)).toEqual(
        classesOf(drawerAppearance({ side, class: "consumer-drawer" })),
      );
      expect(classes(element).has(edgeClass[side])).toBe(true);
      expect(classes(element).has("p-[var(--reddb-spatial-inset-lg)]")).toBe(true);
      expect(classes(element).has("motion-reduce:transition-none")).toBe(true);
    }
  });
});
