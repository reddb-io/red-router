<!-- One native radio group composed from the canonical Fieldset and Label. -->
<script lang="ts">
  import type { HTMLFieldsetAttributes } from "svelte/elements";
  import Fieldset from "./Fieldset.svelte";
  import Label from "./Label.svelte";
  import { radioGroup, type RadioGroupOption } from "./radio-group.variants";

  interface Props extends Omit<HTMLFieldsetAttributes, "children" | "class" | "name"> {
    /** The required visible accessible name rendered as the native legend. */
    legend: string;
    /** One native form name shared by every radio in the group. */
    name: string;
    /** Caller-owned choices; the group owns their native relationship. */
    options: readonly RadioGroupOption[];
    /** The selected native value, bindable by controlled consumers. */
    value?: string;
    /** Applies native required validation to the group. */
    required?: boolean;
    /** Prefix for option ids; otherwise Svelte supplies a stable generated one. */
    id?: string;
    /** Extra classes merged onto the native fieldset. */
    class?: string;
    /** Extra classes merged onto each visible option label. */
    optionClass?: string;
    /** Extra classes merged onto each native radio. */
    controlClass?: string;
  }

  const generatedId = $props.id();
  let {
    legend,
    name,
    options,
    value = $bindable(),
    required = false,
    id,
    class: className,
    optionClass,
    controlClass,
    ...rest
  }: Props = $props();
  const styles = radioGroup();
  const idPrefix = $derived(id ?? `${generatedId}-option`);
</script>

<Fieldset {...rest} {legend} class={styles.root({ class: className })}>
  <div class={styles.list()} data-radio-list>
    {#each options as option, index (option.value)}
      {@const optionId = `${idPrefix}-${index}`}
      <Label class={styles.option({ class: optionClass })} for={optionId}>
        <input
          id={optionId}
          type="radio"
          {name}
          value={option.value}
          bind:group={value}
          {required}
          disabled={option.disabled}
          class={styles.control({ class: controlClass })}
        />
        {option.label}
      </Label>
    {/each}
  </div>
</Fieldset>
