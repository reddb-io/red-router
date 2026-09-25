import { describe, expect, it } from "vitest";
import { ICON_SIZES, Icon } from "../src/index";
import TestGlyph from "./fixtures/TestGlyph.svelte";
import { render, rendered } from "./mount";

describe("the Base Icon", () => {
  it("binds a lucide-shaped glyph to Density size and semantic color tokens", () => {
    expect(ICON_SIZES).toEqual(["sm", "md", "lg"]);

    const icon = rendered(
      render(Icon, {
        icon: TestGlyph,
        size: "sm",
        color: "primary",
        "aria-label": "Create",
      }),
    );

    expect(icon.hasAttribute("data-icon")).toBe(true);
    expect(icon.getAttribute("width")).toBe("var(--reddb-spatial-icon-size-sm)");
    expect(icon.getAttribute("height")).toBe("var(--reddb-spatial-icon-size-sm)");
    expect(icon.getAttribute("color")).toBe("var(--reddb-color-primary)");
    expect(icon.getAttribute("stroke")).toBe("var(--reddb-color-primary)");
    expect(icon.getAttribute("stroke-width")).toBe("2");
    expect(icon.getAttribute("aria-label")).toBe("Create");
    expect(icon.hasAttribute("data-density")).toBe(false);
  });

  it("inherits the surrounding ink when asked for the current color", () => {
    const icon = rendered(render(Icon, { icon: TestGlyph, color: "current", "aria-hidden": "true" }));

    expect(icon.getAttribute("color")).toBe("currentColor");
    expect(icon.getAttribute("stroke")).toBe("currentColor");
  });
});
