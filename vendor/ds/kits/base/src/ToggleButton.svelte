<!-- A pressed-state control composed from the canonical native Button. -->
<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLButtonAttributes } from "svelte/elements";
  import Button from "./Button.svelte";
  import { toggleButton } from "./toggle-button.variants";

  interface Props extends Omit<HTMLButtonAttributes, "aria-pressed" | "children" | "class" | "onclick" | "type"> {
    /** Required visible and accessible control name. */
    label: string;
    /** Current pressed state, bindable for controlled consumers. */
    pressed?: boolean;
    /** Group composition can prohibit removing its sole selection. */
    allowUnpress?: boolean;
    disabled?: boolean;
    class?: string;
    /** Optional visual content; `label` remains the stable accessible name. */
    children?: Snippet;
    onclick?: HTMLButtonAttributes["onclick"];
  }

  let {
    label,
    pressed = $bindable(false),
    allowUnpress = true,
    disabled = false,
    class: className,
    children,
    onclick,
    ...rest
  }: Props = $props();

  function activate(event: MouseEvent): void {
    if (disabled) return;
    if (!pressed || allowUnpress) pressed = !pressed;
    onclick?.(event as Parameters<NonNullable<HTMLButtonAttributes["onclick"]>>[0]);
  }
</script>

<Button
  {...rest}
  {disabled}
  variant="secondary"
  class={toggleButton({ pressed, class: className })}
  aria-pressed={pressed}
  aria-label={children ? label : undefined}
  data-state={pressed ? "on" : "off"}
  data-toggle-button
  onclick={activate}
>
  {#if children}{@render children()}{:else}{label}{/if}
</Button>
