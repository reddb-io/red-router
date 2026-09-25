import { createRawSnippet } from "svelte";
import { describe, expect, it } from "vitest";
import { Card } from "./fixtures/surface-separation-consumer";
import { classes, render, rendered } from "./mount";

const tones = ["neutral", "brand", "success", "warning", "danger", "info"] as const;
const variants = ["outline", "plain"] as const;
const orientations = ["vertical", "horizontal"] as const;

const contracts = {
  neutral: {
    surface: "bg-background",
    border: "border-muted",
    foreground: "text-foreground",
    description: "text-ink-muted",
  },
  brand: {
    surface: "bg-[var(--reddb-color-primary)]",
    border: "border-[var(--reddb-color-primary)]",
    foreground: "text-[var(--reddb-color-on-primary)]",
    description: "text-[var(--reddb-color-on-primary)]",
  },
  success: {
    surface: "bg-[var(--reddb-color-feedback-success-surface)]",
    border: "border-[var(--reddb-color-feedback-success-border)]",
    foreground: "text-[var(--reddb-color-feedback-success-foreground)]",
    description: "text-[var(--reddb-color-feedback-success-foreground)]",
  },
  warning: {
    surface: "bg-[var(--reddb-color-feedback-warning-surface)]",
    border: "border-[var(--reddb-color-feedback-warning-border)]",
    foreground: "text-[var(--reddb-color-feedback-warning-foreground)]",
    description: "text-[var(--reddb-color-feedback-warning-foreground)]",
  },
  danger: {
    surface: "bg-[var(--reddb-color-feedback-danger-surface)]",
    border: "border-[var(--reddb-color-feedback-danger-border)]",
    foreground: "text-[var(--reddb-color-feedback-danger-foreground)]",
    description: "text-[var(--reddb-color-feedback-danger-foreground)]",
  },
  info: {
    surface: "bg-[var(--reddb-color-muted)]",
    border: "border-[var(--reddb-color-muted)]",
    foreground: "text-[var(--reddb-color-foreground)]",
    description: "text-[var(--reddb-color-foreground)]",
  },
} as const;

const content = createRawSnippet(() => ({ render: () => "<span>Body</span>" }));
const media = createRawSnippet(() => ({ render: () => '<img src="/media.webp" alt="" />' }));

describe("the Base Card tone contract", () => {
  it("composes every token-owned tone with both variants and orientations", () => {
    for (const tone of tones) {
      for (const variant of variants) {
        for (const orientation of orientations) {
          const card = rendered(
            render(Card, {
              tone,
              variant,
              orientation,
              title: "Title",
              description: "Description",
              children: content,
              footer: content,
              media,
            }),
          );
          const contract = contracts[tone];

          expect(card.dataset.tone).toBe(tone);
          expect(classes(card).has(contract.surface), `${tone}/${variant}/${orientation}`).toBe(true);
          expect(classes(card).has(contract.foreground), `${tone}/${variant}/${orientation}`).toBe(true);
          expect(classes(card).has(variant === "outline" ? contract.border : "border-transparent")).toBe(true);

          for (const selector of ["[data-card-header]", "[data-card-title]", "[data-card-body]", "[data-card-footer]"]) {
            expect(classes(card.querySelector(selector)!).has(contract.foreground), `${tone} ${selector}`).toBe(true);
          }
          expect(classes(card.querySelector("[data-card-description]")!).has(contract.description)).toBe(true);

          const mediaClasses = classes(card.querySelector("[data-card-media]")!);
          expect([...mediaClasses].some((name) => name.startsWith("bg-") || name.startsWith("text-"))).toBe(false);
        }
      }
    }
  });
});
