<!-- One native radio value composed from the canonical Fieldset and Label. -->
<script lang="ts">
  import type { HTMLFieldsetAttributes } from "svelte/elements";
  import Fieldset from "./Fieldset.svelte";
  import Label from "./Label.svelte";
  import { rating } from "./rating.variants";

  interface Props extends Omit<HTMLFieldsetAttributes, "children" | "class" | "name"> {
    /** Required visible group name rendered as a native legend. */
    legend: string;
    /** One native name shared by every rating radio. */
    name: string;
    /** Current rating; zero means no option is selected. */
    value?: number;
    /** Number of rating stops. */
    max?: number;
    required?: boolean;
    id?: string;
    class?: string;
    optionClass?: string;
    controlClass?: string;
    markClass?: string;
    outputClass?: string;
  }

  const generatedId = $props.id();
  let {
    legend,
    name,
    value = $bindable(0),
    max = 5,
    required = false,
    id,
    class: className,
    optionClass,
    controlClass,
    markClass,
    outputClass,
    ...rest
  }: Props = $props();
  const styles = rating();
  const stops = $derived(Array.from({ length: Math.max(1, Math.floor(max)) }, (_, index) => index + 1));
  const idPrefix = $derived(id ?? `${generatedId}-rating`);
</script>

<Fieldset {...rest} {legend} class={styles.root({ class: className })} data-rating>
  <div class={styles.list()} data-rating-list>
    {#each stops as stop}
      {@const optionId = `${idPrefix}-${stop}`}
      <Label class={styles.option({ class: optionClass })} for={optionId}>
        <input
          id={optionId}
          type="radio"
          {name}
          value={stop}
          bind:group={value}
          {required}
          class={styles.control({ class: controlClass })}
        />
        <span class={styles.mark({ class: markClass })} data-rating-mark aria-hidden="true">
          {stop <= value ? "★" : "☆"}
        </span>
        <span class="sr-only">{stop} of {stops.length}</span>
      </Label>
    {/each}
  </div>
  <output class={styles.output({ class: outputClass })} aria-live="polite">
    {value} of {stops.length}
  </output>
</Fieldset>
