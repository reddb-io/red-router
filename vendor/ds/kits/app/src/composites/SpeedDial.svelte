<script lang="ts">
  import type { Snippet } from "svelte";
  import { Button, Popover } from "@reddb-io/design-system/base";
  import type { SpeedDialAction } from "./command-surfaces.behavior";
  import { speedDial, type SpeedDialSize } from "./speed-dial.variants";

  type Side = "top" | "right" | "bottom" | "left";
  type Align = "start" | "center" | "end";

  interface Props {
    triggerLabel: string;
    contentLabel: string;
    actions?: readonly SpeedDialAction[];
    open?: boolean;
    disabled?: boolean;
    size?: SpeedDialSize;
    side?: Side;
    align?: Align;
    sideOffset?: number;
    collisionPadding?: number;
    trigger?: Snippet;
    class?: string;
  }

  let {
    triggerLabel,
    contentLabel,
    actions = [],
    open = $bindable(false),
    disabled = false,
    size = "md",
    side = "top",
    align = "end",
    sideOffset = 8,
    collisionPadding = 8,
    trigger,
    class: className,
  }: Props = $props();

  const slots = $derived(speedDial({ size }));
</script>

<div data-speed-dial>
  <Popover
    {triggerLabel}
    {contentLabel}
    bind:open
    {disabled}
    variant="primary"
    {size}
    {side}
    {align}
    {sideOffset}
    {collisionPadding}
    {trigger}
    class={slots.content({ class: className })}
  >
    {#each actions as action (action.id)}
      <Button
        data-speed-dial-action
        href={action.href}
        disabled={action.disabled}
        variant="ghost"
        {size}
        class={slots.action()}
        onclick={action.href === undefined ? () => action.onselect?.() : undefined}
      >{action.label}</Button>
    {/each}
  </Popover>
</div>
