import { createRawSnippet } from "svelte";
import { describe, expect, it } from "vitest";
import StatusVocabularyConsumer from "./fixtures/StatusVocabularyConsumer.svelte";
import {
  BADGE_VARIANTS,
  Badge,
  badge,
} from "./fixtures/status-vocabulary-consumer";
import { classes, classesOf, render, rendered } from "./mount";

const label = (value: string) => createRawSnippet(() => ({ render: () => `<span>${value}</span>` }));

describe("the Base Badge", () => {
  it("is available with every emphasis and its Extension Seam through Base", () => {
    expect(Badge).toBeDefined();
    expect(badge).toBeTypeOf("function");
    expect(BADGE_VARIANTS).toEqual(["neutral", "primary", "outline"]);
  });

  it("renders required caller-owned status text inside running text", () => {
    for (const variant of BADGE_VARIANTS) {
      const element = rendered(render(Badge, { variant, children: label(`${variant} release`) }));
      expect(element.tagName).toBe("SPAN");
      expect(element.textContent).toBe(`${variant} release`);
      expect(classes(element)).toEqual(classesOf(badge({ variant })));
    }
  });

  it("does not become a control while preserving native attributes", () => {
    const element = rendered(render(Badge, {
      children: label("Beta"),
      id: "release-stage",
      title: "Release stage",
    }));
    expect(element.tabIndex).toBe(-1);
    expect(element.id).toBe("release-stage");
    expect(element.title).toBe("Release stage");
  });

  it("keeps its Density role live and inherits every nested appearance axis", () => {
    const element = rendered(render(Badge, {
      children: label("Stable"),
      class: "uppercase",
    }));
    const nested = rendered(render(StatusVocabularyConsumer, {})).querySelector<HTMLElement>(
      "[data-badge]",
    )!;

    expect(classes(element)).toEqual(classesOf(badge({ class: "uppercase" })));
    expect(classes(element).has("gap-[var(--reddb-spatial-gap-sm)]")).toBe(true);
    for (const root of [element, nested]) {
      expect(root.hasAttribute("data-theme")).toBe(false);
      expect(root.hasAttribute("data-color-scheme")).toBe(false);
      expect(root.hasAttribute("data-density")).toBe(false);
    }
  });
});
