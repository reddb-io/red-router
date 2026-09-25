<!-- One announced active filter, composed from the canonical Base ToggleGroup. -->
<script lang="ts">
  import { ToggleGroup } from "@reddb-io/design-system/base";
  import type { HTMLFieldsetAttributes } from "svelte/elements";
  import { filter, type FilterOption } from "./filter.variants";

  interface Props extends Omit<HTMLFieldsetAttributes, "children" | "class" | "name"> {
    /** Visible name for the related filter choices. */
    legend: string;
    /** Caller-owned choices; exactly one is announced as pressed. */
    options: readonly FilterOption[];
    /** Active value; an absent value selects the first enabled option. */
    value?: string;
    /** Optional native form name for the active value. */
    name?: string;
    disabled?: boolean;
    class?: string;
    listClass?: string;
    optionClass?: string;
    onvaluechange?: (value: string) => void;
  }

  let {
    legend,
    options,
    value = $bindable(""),
    name,
    disabled = false,
    class: className,
    listClass,
    optionClass,
    onvaluechange,
    ...rest
  }: Props = $props();
  const styles = filter();
</script>

<ToggleGroup
  {...rest}
  {legend}
  {options}
  bind:value
  {name}
  {disabled}
  data-filter
  class={styles.root({ class: className })}
  listClass={styles.list({ class: listClass })}
  {optionClass}
  {onvaluechange}
/>
