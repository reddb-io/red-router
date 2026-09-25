import { describe, expect, it } from "vitest";
import StatusVocabularyConsumer from "./fixtures/StatusVocabularyConsumer.svelte";
import StatusVocabularyContractFailures from "./fixtures/StatusVocabularyContractFailures.svelte";
import {
  STATUS_INDICATOR_STATUSES,
  StatusIndicator,
  statusIndicator,
} from "./fixtures/status-vocabulary-consumer";
import { classes, classesOf, render, rendered } from "./mount";

function statusMeaningFailures(root: HTMLElement): string[] {
  const hasMark = root.querySelector("[data-status-mark]") !== null;
  const label = root.querySelector("[data-status-label]")?.textContent?.trim();
  const accessibleName = root.getAttribute("aria-label")?.trim();
  return hasMark && !label && !accessibleName
    ? ["status is conveyed by colour alone"]
    : [];
}

describe("the Base StatusIndicator", () => {
  it("is available with its status vocabulary and Extension Seam through Base", () => {
    expect(StatusIndicator).toBeDefined();
    expect(statusIndicator).toBeTypeOf("function");
    expect(STATUS_INDICATOR_STATUSES).toEqual([
      "neutral",
      "info",
      "success",
      "warning",
      "danger",
    ]);
  });

  it("always names every status in text, even when the label is visually hidden", () => {
    for (const status of STATUS_INDICATOR_STATUSES) {
      const visible = rendered(render(StatusIndicator, { label: `${status} status`, status }));
      const hidden = rendered(render(StatusIndicator, {
        label: `${status} status`,
        status,
        showLabel: false,
      }));

      expect(visible.textContent).toContain(`${status} status`);
      expect(visible.getAttribute("data-status")).toBe(status);
      expect(classes(hidden.querySelector("[data-status-label]")!).has("sr-only")).toBe(true);
      expect(hidden.querySelector("[data-status-mark]")?.getAttribute("aria-hidden")).toBe("true");
      expect(statusMeaningFailures(hidden)).toEqual([]);
    }
  });

  it("does not become a control while preserving native attributes", () => {
    const element = rendered(render(StatusIndicator, {
      label: "Available",
      id: "availability",
      title: "Current availability",
    }));
    expect(element.tabIndex).toBe(-1);
    expect(element.id).toBe("availability");
    expect(element.title).toBe("Current availability");
  });

  it("wears token-backed appearance and inherits every nested appearance axis", () => {
    const element = rendered(render(StatusIndicator, {
      label: "Delayed",
      status: "warning",
      class: "max-w-40",
    }));
    const nested = rendered(render(StatusVocabularyConsumer, {}))
      .querySelector<HTMLElement>("[data-status-indicator]")!;
    const slots = statusIndicator({ status: "warning" });

    expect(classes(element)).toEqual(classesOf(slots.root({ class: "max-w-40" })));
    expect(classes(element.querySelector("[data-status-mark]")!)).toEqual(classesOf(slots.mark()));
    for (const root of [element, nested]) {
      expect(root.hasAttribute("data-theme")).toBe(false);
      expect(root.hasAttribute("data-color-scheme")).toBe(false);
      expect(root.hasAttribute("data-density")).toBe(false);
    }
  });
});

describe("the deliberately failing status fixture", () => {
  it("diagnoses a status conveyed by colour alone", () => {
    const root = rendered(render(StatusVocabularyContractFailures, {}));
    expect(statusMeaningFailures(root)).toEqual(["status is conveyed by colour alone"]);
  });
});
