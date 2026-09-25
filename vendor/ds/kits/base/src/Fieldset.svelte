<!-- Native related-control grouping with a required visible legend. -->
<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLFieldsetAttributes } from "svelte/elements";
  import { fieldset } from "./fieldset.variants";

  interface Props extends Omit<HTMLFieldsetAttributes, "children" | "class"> {
    /** The accessible name rendered by the fieldset's native legend. */
    legend: string;
    /** The native fieldset element for rare imperative access. */
    ref?: HTMLFieldSetElement;
    /** Extra classes merged onto the group. */
    class?: string;
    /** Extra classes merged onto the legend. */
    legendClass?: string;
    children?: Snippet;
  }

  let {
    legend,
    ref = $bindable(),
    class: className,
    legendClass,
    children,
    ...rest
  }: Props = $props();
  const styles = fieldset();
</script>

<fieldset {...rest} bind:this={ref} class={styles.root({ class: className })}>
  <legend class={styles.legend({ class: legendClass })}>{legend}</legend>
  {@render children?.()}
</fieldset>
