<script lang="ts">
  import type { HTMLAttributes } from "svelte/elements";
  import DescriptionList from "./DescriptionList.svelte";
  import { statistic } from "./statistic.variants";

  interface Props extends Omit<HTMLAttributes<HTMLDListElement>, "class"> {
    /** Caller-owned name for the measured value. */
    label: string;
    /** Machine-readable scalar; formatting changes only its visible form. */
    value: number | string;
    formatValue?: (value: number | string) => string;
    description?: string;
    class?: string;
  }

  let {
    label,
    value,
    formatValue = String,
    description,
    class: className,
    ...rest
  }: Props = $props();
  const slots = $derived(statistic());
  const formatted = $derived(formatValue(value));
</script>

{#snippet detail()}
  <span class={slots.detail()}>
    <data data-statistic-value value={String(value)} class={slots.value()}>{formatted}</data>
    {#if description !== undefined}
      <span data-statistic-description class={slots.description()}>{description}</span>
    {/if}
  </span>
{/snippet}

<DescriptionList
  {...(rest as Record<string, unknown>)}
  data-statistic
  items={[{ term: label, detail }]}
  class={slots.root({ class: className })}
/>
