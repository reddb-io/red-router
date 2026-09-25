<script lang="ts">
  import type { HTMLAttributes } from "svelte/elements";
  import { meter, type MeterTone } from "./meter.variants";
  import { formatPercent, normalizeRange } from "./progress.behavior";

  interface Props extends Omit<HTMLAttributes<HTMLDivElement>, "class"> {
    value: number;
    min?: number;
    max?: number;
    label?: string;
    formatValue?: (value: number) => string;
    /** What the fill means; defaults to the primary emphasis. */
    tone?: MeterTone;
    class?: string;
  }

  const {
    value,
    min = 0,
    max = 100,
    label = "Meter",
    formatValue,
    tone = "neutral",
    class: className,
    ...rest
  }: Props = $props();

  const range = $derived(normalizeRange(value, min, max));
  const valueText = $derived(formatValue?.(range.value) ?? formatPercent(range));
  const slots = $derived(meter({ tone }));
</script>

<div
  {...(rest as Record<string, unknown>)}
  data-meter
  class={slots.root({ class: className })}
  role="meter"
  aria-label={label}
  aria-valuemin={range.min}
  aria-valuemax={range.max}
  aria-valuenow={range.value}
  aria-valuetext={valueText}
>
  <div data-meter-summary class={slots.summary()} aria-hidden="true">
    <span class={slots.label()}>{label}</span>
    <span class={slots.value()}>{valueText}</span>
  </div>
  <div data-meter-track class={slots.track()} aria-hidden="true">
    <div
      data-meter-indicator
      class={slots.indicator()}
      style:width={`${range.percent}%`}
    ></div>
  </div>
</div>
