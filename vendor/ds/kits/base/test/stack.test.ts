import { createRawSnippet } from "svelte";
import { describe, expect, it } from "vitest";
import {
  STACK_GAPS,
  Stack,
  stack as stackAppearance,
  type StackGap,
} from "./fixtures/layout-consumer";
import LayoutConsumer from "./fixtures/LayoutConsumer.svelte";
import { classes, classesOf, render, rendered } from "./mount";

const GAP_CLASS: Record<StackGap, string> = {
  sm: "gap-[var(--reddb-spatial-gap-sm)]",
  md: "gap-[var(--reddb-spatial-gap-md)]",
  lg: "gap-[var(--reddb-spatial-gap-lg)]",
};

describe("the Base Stack", () => {
  it("offers exactly the token-backed flow gaps", () => {
    expect(STACK_GAPS).toEqual(["sm", "md", "lg"]);
    for (const gap of STACK_GAPS) {
      const element = rendered(render(Stack, { gap }));
      expect(classes(element)).toEqual(classesOf(stackAppearance({ gap })));
      expect(classes(element).has(GAP_CLASS[gap])).toBe(true);
    }
  });

  it("defaults to the medium gap and preserves child order", () => {
    const element = rendered(
      render(Stack, {
        "aria-label": "Ordered steps",
        class: "min-w-0",
        children: createRawSnippet(() => ({
          render: () => "<div><span>First</span><span>Second</span></div>",
        })),
      }),
    );

    expect(element.getAttribute("aria-label")).toBe("Ordered steps");
    expect(classes(element)).toEqual(
      classesOf(stackAppearance({ gap: "md", class: "min-w-0" })),
    );
    expect(
      [...(element.firstElementChild?.children ?? [])].map((child) => child.textContent),
    ).toEqual(["First", "Second"]);
  });

  it("keeps its public gap while a nested Density scope re-resolves it", () => {
    const root = render(LayoutConsumer);
    const outer = root.querySelector<HTMLElement>('[aria-label="Deployment flow"]')!;
    const inner = root.querySelector<HTMLElement>('[data-density="compact"] [data-stack]')!;

    expect(classes(outer).has(GAP_CLASS.lg)).toBe(true);
    expect(classes(inner).has(GAP_CLASS.sm)).toBe(true);
    expect(outer.hasAttribute("data-density")).toBe(false);
    expect(inner.hasAttribute("data-density")).toBe(false);
  });
});
