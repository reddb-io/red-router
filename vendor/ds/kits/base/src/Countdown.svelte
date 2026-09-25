<script lang="ts">
  import type { HTMLAttributes } from "svelte/elements";
  import {
    durationAttribute,
    formatDuration,
    normalizeRemaining,
  } from "./countdown.behavior";
  import { countdown } from "./countdown.variants";

  interface Props extends Omit<HTMLAttributes<HTMLDivElement>, "class"> {
    /** Caller-controlled remaining time in seconds. */
    remaining: number;
    label?: string;
    completeLabel?: string;
    formatValue?: (remaining: number) => string;
    class?: string;
  }

  let {
    remaining,
    label = "Time remaining",
    completeLabel = "Complete",
    formatValue = formatDuration,
    class: className,
    ...rest
  }: Props = $props();
  const seconds = $derived(normalizeRemaining(remaining));
  const complete = $derived(seconds === 0);
  const slots = $derived(countdown());
</script>

<div
  {...(rest as Record<string, unknown>)}
  data-countdown
  data-state={complete ? "complete" : "running"}
  role={complete ? "status" : "timer"}
  aria-live={complete ? "polite" : "off"}
  aria-atomic="true"
  class={slots.root({ class: className })}
>
  <span data-countdown-label class={slots.label()}>{label}</span>
  <time datetime={durationAttribute(seconds)} class={slots.value()}>
    {complete ? completeLabel : formatValue(seconds)}
  </time>
</div>
