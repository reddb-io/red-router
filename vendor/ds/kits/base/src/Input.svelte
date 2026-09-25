<!--
  Input — the canonical Base text entry.

  It stays a native <input>: the complete platform attribute surface is spread
  through, including identity, autofill, constraints, validation, events and
  the native `size` attribute. `value` is bindable (`bind:value`), and `ref`
  is bindable for the rare caller that must move focus imperatively; ordinary
  focus remains the browser's own behavior.
-->
<script lang="ts">
  import { untrack } from "svelte";
  import type { HTMLInputAttributes } from "svelte/elements";
  import { input } from "./input.variants";

  interface Props extends Omit<HTMLInputAttributes, "class" | "value"> {
    /** The current value. Bindable: `bind:value` follows every keystroke. */
    value?: HTMLInputAttributes["value"];
    /** The native input element, available for imperative focus or selection. */
    ref?: HTMLInputElement;
    /** Extra classes, merged over the canonical appearance. */
    class?: string;
  }

  let {
    ref = $bindable(),
    value = $bindable(),
    class: className,
    oninput,
    ...rest
  }: Props = $props();

  // The element stays the source of truth for what was typed. `value` follows
  // it on every input and is written back only when a caller supplies one, so a
  // Field (or any spread) re-rendering around an uncontrolled Input can never
  // blank it by passing `undefined` again.
  const initial = untrack(() => value);

  function handleInput(event: Event & { currentTarget: EventTarget & HTMLInputElement }): void {
    const element = event.currentTarget;
    value =
      element.type === "number" || element.type === "range"
        ? element.value === ""
          ? null
          : element.valueAsNumber
        : element.value;
    oninput?.(event);
  }

  $effect(() => {
    const next = value;
    if (!ref || next === undefined || next === null || ref.type === "file") return;
    if (String(next) !== ref.value) ref.value = String(next);
  });
</script>

<input
  {...rest}
  value={initial}
  bind:this={ref}
  oninput={handleInput}
  class={input({ class: className })}
/>
