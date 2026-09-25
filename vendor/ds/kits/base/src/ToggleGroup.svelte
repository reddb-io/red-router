<!-- Exactly one pressed option, composed from canonical Fieldset and ToggleButton. -->
<script lang="ts">
  import type { HTMLFieldsetAttributes } from "svelte/elements";
  import Fieldset from "./Fieldset.svelte";
  import ToggleButton from "./ToggleButton.svelte";
  import { toggleGroup, type ToggleGroupOption } from "./toggle-group.variants";

  interface Props extends Omit<HTMLFieldsetAttributes, "children" | "class" | "name"> {
    legend: string;
    options: readonly ToggleGroupOption[];
    /** Selected option value; an absent value selects the first enabled option. */
    value?: string;
    /** Optional native form name for the selected value. */
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
  const styles = toggleGroup();
  const selected = $derived(
    options.some((option) => !option.disabled && option.value === value)
      ? value
      : (options.find((option) => !option.disabled)?.value ?? ""),
  );
  let list: HTMLDivElement;

  function choose(option: ToggleGroupOption): void {
    if (disabled || option.disabled || option.value === selected) return;
    value = option.value;
    onvaluechange?.(option.value);
  }

  function move(event: KeyboardEvent, current: number): void {
    const enabled = options
      .map((option, index) => ({ option, index }))
      .filter(({ option }) => !option.disabled);
    const position = enabled.findIndex(({ index }) => index === current);
    if (position < 0 || enabled.length === 0) return;

    let next: number | undefined;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (position + 1) % enabled.length;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (position - 1 + enabled.length) % enabled.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = enabled.length - 1;
    if (next === undefined) return;

    event.preventDefault();
    const target = enabled[next]!;
    choose(target.option);
    list.querySelectorAll<HTMLButtonElement>("button")[target.index]?.focus();
  }
</script>

<Fieldset {...rest} {legend} {disabled} class={styles.root({ class: className })} data-toggle-group>
  <div bind:this={list} class={styles.list({ class: listClass })} role="group" aria-label={legend}>
    {#each options as option, index (option.value)}
      <ToggleButton
        label={option.label}
        pressed={option.value === selected}
        allowUnpress={false}
        disabled={disabled || option.disabled}
        class={styles.option({ class: optionClass })}
        tabindex={option.value === selected ? 0 : -1}
        data-toggle-value={option.value}
        onclick={() => choose(option)}
        onkeydown={(event) => move(event, index)}
      />
    {/each}
  </div>
  {#if name}
    <input type="hidden" {name} value={selected} {disabled} />
  {/if}
</Fieldset>
