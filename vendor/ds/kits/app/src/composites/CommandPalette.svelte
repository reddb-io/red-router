<!-- Global command search composed from the canonical Popover and Combobox contracts. -->
<script lang="ts">
  import { Combobox, Popover, type ComboboxOption } from "@reddb-io/design-system/base";
  import type { CommandPaletteCommand } from "./command-palette.behavior";
  import { commandPalette } from "./command-palette.variants";

  interface Props {
    /** Accessible name and visible fallback for the invoking Button. */
    triggerLabel: string;
    /** Accessible name for the Popover dialog. */
    contentLabel: string;
    /** Visible Field label for command search. */
    label: string;
    /** Caller-owned command names and business actions. */
    commands?: readonly CommandPaletteCommand[];
    /** Whether the palette is open. */
    open?: boolean;
    disabled?: boolean;
    class?: string;
    contentClass?: string;
    inputClass?: string;
    onselect?: (command: CommandPaletteCommand) => void;
  }

  let {
    triggerLabel,
    contentLabel,
    label,
    commands = [],
    open = $bindable(false),
    disabled = false,
    class: className,
    contentClass,
    inputClass,
    onselect,
  }: Props = $props();

  const slots = commandPalette();
  let value = $state("");
  const options = $derived<readonly ComboboxOption[]>(
    commands.map(({ id, label: commandLabel, disabled: commandDisabled }) => ({
      value: id,
      label: commandLabel,
      disabled: commandDisabled,
    })),
  );

  function choose(id: string): void {
    const command = commands.find((candidate) => candidate.id === id);
    if (command === undefined) return;
    command.onselect?.();
    onselect?.(command);
    open = false;
    // A command is an action, not a chosen value: forget it, or choosing the
    // same command next time toggles the selection off instead of running it.
    value = "";
  }
</script>

<div data-command-palette class={slots.root({ class: className })}>
  <Popover
    {triggerLabel}
    {contentLabel}
    {disabled}
    bind:open
    class={slots.content({ class: contentClass })}
  >
    <Combobox
      {label}
      {options}
      bind:value
      {inputClass}
      class={slots.search()}
      onvaluechange={choose}
    />
  </Popover>
</div>
