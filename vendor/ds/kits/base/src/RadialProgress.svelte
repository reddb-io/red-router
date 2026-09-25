<script lang="ts">
  import type { HTMLAttributes } from "svelte/elements";
  import { formatPercent, isDeterminate, normalizeRange } from "./progress.behavior";
  import {
    radialProgress,
    type RadialProgressSize,
  } from "./radial-progress.variants";

  interface Props extends Omit<HTMLAttributes<HTMLDivElement>, "class"> {
    /** Omit the value for an indeterminate radial indicator. */
    value?: number | null;
    min?: number;
    max?: number;
    label?: string;
    size?: RadialProgressSize;
    formatValue?: (value: number) => string;
    class?: string;
  }

  const {
    value,
    min = 0,
    max = 100,
    label = "Progress",
    size = "md",
    formatValue,
    class: className,
    ...rest
  }: Props = $props();

  const determinate = $derived(isDeterminate(value));
  const range = $derived(normalizeRange(isDeterminate(value) ? value : min, min, max));
  const valueText = $derived(
    determinate ? (formatValue?.(range.value) ?? formatPercent(range)) : "In progress",
  );
  const slots = $derived(radialProgress({ size, indeterminate: !determinate }));
</script>

<div
  {...(rest as Record<string, unknown>)}
  data-radial-progress
  data-state={determinate ? "determinate" : "indeterminate"}
  class={slots.root({ class: className })}
  role="progressbar"
  aria-label={label}
  aria-valuemin={range.min}
  aria-valuemax={range.max}
  aria-valuenow={determinate ? range.value : undefined}
  aria-valuetext={valueText}
>
  <svg class={slots.svg()} viewBox="0 0 36 36" aria-hidden="true">
    <circle class={slots.track()} cx="18" cy="18" r="15.5" stroke-width="3" />
    <circle
      class={slots.indicator()}
      cx="18"
      cy="18"
      r="15.5"
      pathLength="100"
      stroke-width="3"
      stroke-linecap="round"
      stroke-dasharray={determinate ? 100 : 25}
      stroke-dashoffset={determinate ? 100 - range.percent : 0}
    />
  </svg>
  <span class={slots.value()}>{valueText}</span>
</div>
