<!-- Multiple announced category filters, composed from canonical Base form contracts. -->
<script lang="ts">
  import { Checkbox, Fieldset } from "@reddb-io/design-system/base";
  import type { HTMLFieldsetAttributes } from "svelte/elements";
  import { categoryFilter, type CategoryFilterOption } from "./category-filter.variants";

  interface Props extends Omit<HTMLFieldsetAttributes, "children" | "class" | "name"> {
    /** Visible name for the category choices. */
    legend: string;
    /** Caller-owned categories rendered as native checkbox choices. */
    options: readonly CategoryFilterOption[];
    /** Active category values, bindable by controlled consumers. */
    values?: string[];
    /** Optional native form name shared by every category. */
    name?: string;
    disabled?: boolean;
    class?: string;
    listClass?: string;
    optionClass?: string;
    onvalueschange?: (values: string[]) => void;
  }

  let {
    legend,
    options,
    values = $bindable([]),
    name,
    disabled = false,
    class: className,
    listClass,
    optionClass,
    onvalueschange,
    ...rest
  }: Props = $props();
  const styles = categoryFilter();

  function change(value: string, checked: boolean): void {
    const next = checked
      ? values.includes(value)
        ? values
        : [...values, value]
      : values.filter((candidate) => candidate !== value);
    values = next;
    onvalueschange?.([...next]);
  }
</script>

<Fieldset
  {...rest}
  {legend}
  {disabled}
  data-category-filter
  class={styles.root({ class: className })}
>
  <div data-category-filter-list class={styles.list({ class: listClass })}>
    {#each options as option (option.value)}
      <Checkbox
        label={option.label}
        {name}
        value={option.value}
        checked={values.includes(option.value)}
        disabled={disabled || option.disabled}
        fieldClass={styles.option({ class: optionClass })}
        onchange={(event) => change(option.value, event.currentTarget.checked)}
      />
    {/each}
  </div>
</Fieldset>
