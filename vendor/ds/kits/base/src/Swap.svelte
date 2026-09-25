<!-- Two caller-owned faces over the canonical ToggleButton pressed contract. -->
<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLButtonAttributes } from "svelte/elements";
  import ToggleButton from "./ToggleButton.svelte";
  import { swap } from "./swap.variants";

  interface Props extends Omit<HTMLButtonAttributes, "aria-pressed" | "children" | "class" | "onclick" | "onchange" | "type"> {
    /** Stable accessible name; changing faces never changes the control's purpose. */
    label: string;
    /** Which face is visible, bindable for controlled consumers. */
    swapped?: boolean;
    /** Content shown in the initial, unpressed state. Defaults to `label`. */
    off?: Snippet;
    /** Content shown in the swapped, pressed state. Defaults to `label`. */
    on?: Snippet;
    disabled?: boolean;
    class?: string;
    onclick?: HTMLButtonAttributes["onclick"];
    /** Reports the next state after native activation. */
    onchange?: (swapped: boolean) => void;
  }

  let {
    label,
    swapped = $bindable(false),
    off,
    on,
    disabled = false,
    class: className,
    onclick,
    onchange,
    ...rest
  }: Props = $props();

  function activate(event: MouseEvent): void {
    onclick?.(event as Parameters<NonNullable<HTMLButtonAttributes["onclick"]>>[0]);
    onchange?.(swapped);
  }
</script>

<ToggleButton
  {...rest}
  {label}
  {disabled}
  bind:pressed={swapped}
  class={swap({ class: className })}
  data-swap
  onclick={activate}
>
  {#if swapped}
    {#if on}{@render on()}{:else}{label}{/if}
  {:else}
    {#if off}{@render off()}{:else}{label}{/if}
  {/if}
</ToggleButton>
