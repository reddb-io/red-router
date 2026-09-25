import { flushSync } from "svelte";
import { describe, expect, it, vi } from "vitest";
import BinaryChoiceConsumer from "./fixtures/BinaryChoiceConsumer.svelte";
import BinaryChoiceContractFailures from "./fixtures/BinaryChoiceContractFailures.svelte";
import { RadioGroup, radioGroup } from "./fixtures/binary-choice-consumer";
import { classes, classesOf, render, rendered } from "./mount";

const OPTIONS = [
  { value: "stable", label: "Stable" },
  { value: "preview", label: "Preview" },
  { value: "nightly", label: "Nightly", disabled: true },
] as const;

function radioNameFailures(root: HTMLElement): string[] {
  const names = new Set(
    [...root.querySelectorAll<HTMLInputElement>('input[type="radio"]')].map(
      (control) => control.name,
    ),
  );
  return names.size === 1 && !names.has("")
    ? []
    : ["radio group does not share one non-empty name"];
}

describe("the Base RadioGroup", () => {
  it("is available with its Extension Seam through the Base consumer subpath", () => {
    expect(RadioGroup).toBeDefined();
    expect(radioGroup).toBeTypeOf("function");
  });

  it("composes Fieldset into one visibly named native radio group", () => {
    const element = rendered(
      render(RadioGroup, {
        legend: "Release channel",
        name: "channel",
        options: OPTIONS,
        required: true,
      }),
    ) as HTMLFieldSetElement;
    const controls = [...element.querySelectorAll<HTMLInputElement>('input[type="radio"]')];

    expect(element.tagName).toBe("FIELDSET");
    expect(element.querySelector(":scope > legend")?.textContent).toBe("Release channel");
    expect(controls).toHaveLength(3);
    expect(controls.map(({ name }) => name)).toEqual(["channel", "channel", "channel"]);
    expect(controls.every(({ required }) => required)).toBe(true);
    expect(controls[2]?.disabled).toBe(true);
    expect(
      controls.map((control) =>
        element.querySelector(`label[for="${control.id}"]`)?.textContent?.trim(),
      ),
    ).toEqual(["Stable", "Preview", "Nightly"]);
    expect(radioNameFailures(element)).toEqual([]);
  });

  it("keeps native focus, exclusive selection, form value, and keyboard events", () => {
    const onkeydown = vi.fn();
    const form = rendered(render(BinaryChoiceConsumer, { radioOnkeydown: onkeydown }));
    const controls = [...form.querySelectorAll<HTMLInputElement>('input[name="channel"]')];

    expect(controls[0]?.checked).toBe(true);
    controls[1]!.click();
    flushSync();
    expect(controls[0]?.checked).toBe(false);
    expect(controls[1]?.checked).toBe(true);
    expect(new FormData(form as HTMLFormElement).get("channel")).toBe("preview");

    controls[1]!.focus();
    expect(document.activeElement).toBe(controls[1]);
    controls[1]!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
    );
    flushSync();
    expect(onkeydown).toHaveBeenCalledTimes(1);
    expect(onkeydown.mock.calls[0]?.[0]).toMatchObject({ key: "ArrowUp" });
  });

  it("wears its exported appearance without selecting an appearance axis", () => {
    const element = rendered(
      render(RadioGroup, {
        legend: "Release channel",
        name: "channel",
        options: OPTIONS,
        class: "min-w-0",
      }),
    );
    const styles = radioGroup();
    const list = element.querySelector<HTMLElement>("[data-radio-list]")!;
    const control = element.querySelector<HTMLInputElement>('input[type="radio"]')!;
    const nested = rendered(render(BinaryChoiceConsumer, {})).querySelector<HTMLFieldSetElement>(
      "[data-appearance-scope] fieldset",
    )!;

    expect(classes(element)).toEqual(classesOf(styles.root({ class: "min-w-0" })));
    expect(classes(list)).toEqual(classesOf(styles.list()));
    expect(classes(control)).toEqual(classesOf(styles.control()));
    expect(classes(list).has("gap-[var(--reddb-spatial-gap-sm)]")).toBe(true);
    expect(element.hasAttribute("data-theme")).toBe(false);
    expect(element.hasAttribute("data-color-scheme")).toBe(false);
    expect(element.hasAttribute("data-density")).toBe(false);
    expect(nested.hasAttribute("data-theme")).toBe(false);
    expect(nested.hasAttribute("data-color-scheme")).toBe(false);
    expect(nested.hasAttribute("data-density")).toBe(false);
    expect(
      classes(nested.querySelector("[data-radio-list]")!).has(
        "gap-[var(--reddb-spatial-gap-sm)]",
      ),
    ).toBe(true);
  });
});

describe("the deliberately failing radio-group fixture", () => {
  it("diagnoses radios without one shared name", () => {
    const root = rendered(
      render(BinaryChoiceContractFailures, { failure: "unshared-radio-name" }),
    );
    expect(radioNameFailures(root)).toEqual([
      "radio group does not share one non-empty name",
    ]);
  });
});
