// Button at the Base subpath, through the same public seam a consumer uses.
//
// These assertions preserve the observable contract moved out of Application.
// Base is now its only implementation and public export.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRawSnippet, flushSync, type Snippet } from "svelte";
import { describe, expect, it, vi } from "vitest";
import {
  APPEARANCE_THEMES,
  BASE_THEME,
  COLOR_SCHEMES,
} from "../../../packages/theme/src/appearance";
import { appearanceThemeCssPath, colorSchemeCssPath } from "../../../packages/theme/src/paths";
import {
  cascadeFor,
  parseStylesheets,
  resolveProperty,
} from "../../../packages/theme/test/support/cascade";
import {
  BUTTON_INTENTS,
  BUTTON_SIZES,
  BUTTON_VARIANTS,
  Button,
  button,
  buttonSpinner,
} from "./fixtures/button-consumer";
import { classes, classesOf, render, rendered } from "./mount";

function text(content: string): Snippet {
  return createRawSnippet(() => ({ render: () => `<span>${content}</span>` }));
}

function click(element: HTMLElement): void {
  element.click();
  flushSync();
}

const composition = parseStylesheets([
  readFileSync(join(import.meta.dirname, "..", "..", "..", "packages", "tokens", "dist", "tokens.css"), "utf8"),
  readFileSync(appearanceThemeCssPath(BASE_THEME), "utf8"),
  ...APPEARANCE_THEMES.map((theme) => readFileSync(appearanceThemeCssPath(theme), "utf8")),
  ...COLOR_SCHEMES.map((scheme) => readFileSync(colorSchemeCssPath(scheme), "utf8")),
]);

function channel(hex: string, offset: number): number {
  const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}

function contrast(left: string, right: string): number {
  const [lighter, darker] = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("the Base Button", () => {
  it("is available through the Base consumer subpath", () => {
    expect(Button).toBeDefined();
    expect(button).toBeTypeOf("function");
    expect(buttonSpinner).toBeTypeOf("function");
    expect(BUTTON_INTENTS).toEqual(["neutral", "danger", "success", "warning", "info"]);
  });

  it("renders a <button> that does not submit its form by accident", () => {
    const element = rendered(render(Button, {}));
    expect(element.tagName).toBe("BUTTON");
    expect(element.getAttribute("type")).toBe("button");
  });

  it("renders its children", () => {
    const element = rendered(render(Button, { children: text("Save") }));
    expect(element.textContent?.trim()).toBe("Save");
  });

  it("wears exactly the classes its exported variants produce", () => {
    for (const variant of BUTTON_VARIANTS) {
      for (const size of BUTTON_SIZES) {
        const element = rendered(render(Button, { variant, size }));
        expect(classes(element)).toEqual(classesOf(button({ variant, size })));
      }
    }
  });

  it("defaults to the primary variant at the medium size", () => {
    const element = rendered(render(Button, {}));
    expect(classes(element)).toEqual(classesOf(button({ variant: "primary", size: "md" })));
  });

  it("composes every intent with every emphasis using only its token family", () => {
    // A feedback intent keeps the emphasis hierarchy: primary fills with the
    // role's text-grade stop, secondary outlines in its border, ghost carries
    // only its ink — so the three emphases stay distinguishable (ADR 0009).
    const feedback = (role: string) => ({
      primary: [`bg-feedback-${role}-foreground`, "text-on-feedback", "focus-visible:ring-foreground"],
      secondary: [
        `border-feedback-${role}-border`,
        `text-feedback-${role}-foreground`,
        `hover:bg-feedback-${role}-surface`,
        `focus-visible:ring-feedback-${role}-foreground`,
      ],
      ghost: [`text-feedback-${role}-foreground`, `hover:bg-feedback-${role}-surface`, `focus-visible:ring-feedback-${role}-foreground`],
    });
    const contracts = {
      neutral: {
        primary: ["bg-primary", "text-on-primary", "focus-visible:ring-foreground"],
        secondary: ["border-control-edge", "bg-transparent", "text-foreground", "focus-visible:ring-foreground"],
        ghost: ["bg-transparent", "text-ink-muted", "focus-visible:ring-foreground"],
      },
      danger: feedback("danger"),
      success: feedback("success"),
      warning: feedback("warning"),
      info: feedback("info"),
    } as const;

    for (const [intent, variants] of Object.entries(contracts)) {
      for (const [variant, expected] of Object.entries(variants)) {
        const actual = classesOf(button({ intent, variant } as never));
        for (const token of expected) expect(actual.has(token), `${intent}/${variant}: ${token}`).toBe(true);
        expect([...actual], `${intent}/${variant}`).not.toContainEqual(expect.stringMatching(/(?:#[\da-f]{3,8}|(?:rgb|hsl)a?\()/i));
      }
    }
  });

  it("renders the requested intent through the public component prop", () => {
    for (const intent of ["neutral", "danger", "success", "warning", "info"] as const) {
      for (const variant of BUTTON_VARIANTS) {
        const element = rendered(render(Button, { intent, variant }));
        expect(classes(element), `${intent}/${variant}`).toEqual(
          classesOf(button({ intent, variant })),
        );
      }
    }
  });

  it("keeps labels and focus rings at AA contrast for every intent surface and appearance", () => {
    const pairs = {
      neutral: {
        primary: ["--reddb-color-primary", "--reddb-color-on-primary", "--reddb-color-on-primary"],
        secondary: ["--reddb-color-background", "--reddb-color-foreground", "--reddb-color-foreground"],
        ghost: ["--reddb-color-background", "--reddb-color-ink-muted", "--reddb-color-foreground"],
      },
      danger: {
        primary: ["--reddb-color-feedback-danger-surface", "--reddb-color-feedback-danger-foreground", "--reddb-color-feedback-danger-foreground"],
        secondary: ["--reddb-color-feedback-danger-surface", "--reddb-color-feedback-danger-foreground", "--reddb-color-feedback-danger-foreground"],
        ghost: ["--reddb-color-feedback-danger-surface", "--reddb-color-feedback-danger-foreground", "--reddb-color-feedback-danger-foreground"],
      },
      success: {
        primary: ["--reddb-color-feedback-success-surface", "--reddb-color-feedback-success-foreground", "--reddb-color-feedback-success-foreground"],
        secondary: ["--reddb-color-feedback-success-surface", "--reddb-color-feedback-success-foreground", "--reddb-color-feedback-success-foreground"],
        ghost: ["--reddb-color-feedback-success-surface", "--reddb-color-feedback-success-foreground", "--reddb-color-feedback-success-foreground"],
      },
      warning: {
        primary: ["--reddb-color-feedback-warning-surface", "--reddb-color-feedback-warning-foreground", "--reddb-color-feedback-warning-foreground"],
        secondary: ["--reddb-color-feedback-warning-surface", "--reddb-color-feedback-warning-foreground", "--reddb-color-feedback-warning-foreground"],
        ghost: ["--reddb-color-feedback-warning-surface", "--reddb-color-feedback-warning-foreground", "--reddb-color-feedback-warning-foreground"],
      },
      info: {
        primary: ["--reddb-color-muted", "--reddb-color-foreground", "--reddb-color-foreground"],
        secondary: ["--reddb-color-muted", "--reddb-color-foreground", "--reddb-color-foreground"],
        ghost: ["--reddb-color-muted", "--reddb-color-foreground", "--reddb-color-foreground"],
      },
    } as const;

    for (const theme of APPEARANCE_THEMES) {
      for (const scheme of COLOR_SCHEMES) {
        const cascade = cascadeFor(composition, [
          { "data-theme": theme.name, "data-color-scheme": scheme.name },
        ]);
        for (const [intent, variants] of Object.entries(pairs)) {
          for (const [variant, [surfaceToken, labelToken, ringToken]] of Object.entries(variants)) {
            const surface = resolveProperty(cascade, surfaceToken);
            const appearance = `${intent}/${variant} at ${theme.name}/${scheme.name}`;
            expect(contrast(surface, resolveProperty(cascade, labelToken)), `${appearance} label`)
              .toBeGreaterThanOrEqual(4.5);
            expect(contrast(surface, resolveProperty(cascade, ringToken)), `${appearance} focus ring`)
              .toBeGreaterThanOrEqual(4.5);
          }
        }
      }
    }
  });

  it("merges a caller's classes over its own", () => {
    const element = rendered(render(Button, { class: "w-full" }));
    expect(classes(element).has("w-full")).toBe(true);
    expect(classes(element).has("bg-primary")).toBe(true);
  });

  it("passes native attributes and handlers straight through", () => {
    const onclick = vi.fn();
    const element = rendered(render(Button, { onclick, type: "submit", "aria-pressed": "true" }));
    expect(element.getAttribute("type")).toBe("submit");
    expect(element.getAttribute("aria-pressed")).toBe("true");
    click(element);
    expect(onclick).toHaveBeenCalledTimes(1);
  });

  it("does not fire while disabled", () => {
    const onclick = vi.fn();
    const element = rendered(render(Button, { onclick, disabled: true }));
    expect((element as HTMLButtonElement).disabled).toBe(true);
    click(element);
    expect(onclick).not.toHaveBeenCalled();
  });
});

describe("the Base Button as an anchor", () => {
  it("renders an <a> to wherever href points", () => {
    const element = rendered(render(Button, { href: "/docs", children: text("Read the guide") }));
    expect(element.tagName).toBe("A");
    expect(element.getAttribute("href")).toBe("/docs");
    expect(element.hasAttribute("type")).toBe(false);
  });

  it("wears the same variant classes as a button", () => {
    for (const variant of BUTTON_VARIANTS) {
      for (const size of BUTTON_SIZES) {
        const anchor = rendered(render(Button, { href: "/docs", variant, size }));
        expect(classes(anchor)).toEqual(classesOf(button({ variant, size })));
      }
    }
  });

  it("passes native anchor attributes straight through", () => {
    const element = rendered(
      render(Button, { href: "https://example.test", target: "_blank", rel: "noreferrer" }),
    );
    expect(element.getAttribute("target")).toBe("_blank");
    expect(element.getAttribute("rel")).toBe("noreferrer");
  });

  it("withholds the destination while disabled", () => {
    const element = rendered(render(Button, { href: "/docs", disabled: true }));
    expect(element.hasAttribute("href")).toBe(false);
    expect(element.getAttribute("tabindex")).toBe("-1");
    expect(element.getAttribute("aria-disabled")).toBe("true");
  });
});

describe("the Base Button while loading", () => {
  it("is disabled, announces itself as busy, and does not fire", () => {
    const onclick = vi.fn();
    const element = rendered(render(Button, { onclick, loading: true, children: text("Save") }));
    expect((element as HTMLButtonElement).disabled).toBe(true);
    expect(element.getAttribute("aria-busy")).toBe("true");
    click(element);
    expect(onclick).not.toHaveBeenCalled();
  });

  it("draws an assistive-technology-hidden spinner beside its label", () => {
    const element = rendered(render(Button, { loading: true, children: text("Save") }));
    const spinner = element.querySelector("svg");
    expect(spinner).not.toBeNull();
    expect(classes(spinner!)).toEqual(classesOf(buttonSpinner({ size: "md" }).root()));
    expect(spinner!.getAttribute("aria-hidden")).toBe("true");
    expect(element.textContent).toContain("Save");
  });

  it("sizes the spinner with the button", () => {
    for (const size of BUTTON_SIZES) {
      const spinner = rendered(render(Button, { loading: true, size })).querySelector("svg")!;
      expect(classes(spinner)).toEqual(classesOf(buttonSpinner({ size }).root()));
    }
  });

  it("draws the spinner in the button's own colour", () => {
    const spinner = rendered(render(Button, { loading: true, variant: "secondary" })).querySelector("svg")!;
    const strokeClasses = [...spinner.querySelectorAll("*")].flatMap((node) => [...classes(node)]);
    expect(strokeClasses).toContain("stroke-current");
    const coloured = [...classes(spinner), ...strokeClasses].filter((name) =>
      /^(text|fill|stroke)-/.test(name),
    );
    expect(coloured.filter((name) => !/-(current|none)$/.test(name))).toEqual([]);
  });

  it("draws no spinner when it is not loading", () => {
    expect(rendered(render(Button, { children: text("Save") })).querySelector("svg")).toBeNull();
  });

  it("takes an anchor out of action too", () => {
    const element = rendered(render(Button, { href: "/docs", loading: true }));
    expect(element.tagName).toBe("A");
    expect(element.hasAttribute("href")).toBe(false);
    expect(element.querySelector("svg")).not.toBeNull();
  });
});

describe("the Base Button as a block", () => {
  it("fills its column when asked, and only then", () => {
    expect(classes(rendered(render(Button, { block: true }))).has("w-full")).toBe(true);
    expect(classes(rendered(render(Button, {}))).has("w-full")).toBe(false);
  });

  it("wears the exported block classes on either native element", () => {
    for (const variant of BUTTON_VARIANTS) {
      const asButton = rendered(render(Button, { variant, block: true }));
      expect(classes(asButton)).toEqual(classesOf(button({ variant, block: true })));

      const asAnchor = rendered(render(Button, { href: "/docs", variant, block: true }));
      expect(classes(asAnchor)).toEqual(classesOf(button({ variant, block: true })));
    }
  });
});
