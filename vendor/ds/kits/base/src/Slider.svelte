<!-- A native range input composed through the canonical Field relationship. -->
<script lang="ts">
  import type { HTMLInputAttributes } from "svelte/elements";
  import Field from "./Field.svelte";
  import { slider } from "./slider.variants";

  interface Props extends Omit<HTMLInputAttributes, "children" | "class" | "id" | "max" | "min" | "step" | "type" | "value"> {
    /** Required visible name supplied through Field. */
    label: string;
    help?: string;
    error?: string;
    required?: boolean;
    id?: string;
    /** Current native numeric value. */
    value?: number;
    min?: number;
    max?: number;
    step?: number | "any";
    /** Visible and accessible wording for the current numeric value. */
    formatValue?: (value: number) => string;
    class?: string;
    fieldClass?: string;
    outputClass?: string;
    ref?: HTMLInputElement;
  }

  let {
    label,
    help,
    error,
    required = false,
    id,
    value = $bindable(0),
    min = 0,
    max = 100,
    step = 1,
    formatValue,
    class: className,
    fieldClass,
    outputClass,
    ref = $bindable(),
    ...rest
  }: Props = $props();
  const styles = slider();
  const formatted = $derived(formatValue ? formatValue(value) : String(value));
</script>

<div class={styles.root()} data-slider>
  <Field {label} {help} {error} {required} {id} class={fieldClass}>
    {#snippet children(control)}
      <input
        {...rest}
        {...control}
        bind:this={ref}
        bind:value
        type="range"
        {min}
        {max}
        {step}
        aria-valuetext={formatValue ? formatted : undefined}
        class={styles.control({ class: className })}
      />
      <output class={styles.output({ class: outputClass })} for={control.id} aria-live="polite">
        {formatted}
      </output>
    {/snippet}
  </Field>
</div>
