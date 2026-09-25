<!-- A synchronized DateField and Calendar under the canonical Popover lifecycle. -->
<script lang="ts">
  import { parseDate, type DateValue } from "@internationalized/date";
  import type { Snippet } from "svelte";
  import Calendar from "./Calendar.svelte";
  import DateField from "./DateField.svelte";
  import Popover from "./Popover.svelte";
  import { datePicker } from "./date-picker.variants";

  type Side = "top" | "right" | "bottom" | "left";
  type Align = "start" | "center" | "end";

  interface Props {
    /** Visible DateField label. */
    label: string;
    /** Accessible name for the Calendar grid and Popover dialog. */
    calendarLabel: string;
    /** Accessible name for the canonical Button that opens the calendar. */
    triggerLabel?: string;
    /** Native form name receiving the synchronized complete date. */
    name?: string;
    /** Complete ISO calendar date shared by DateField and Calendar. */
    value?: string;
    help?: string;
    error?: string;
    required?: boolean;
    disabled?: boolean;
    id?: string;
    /** Whether the calendar Popover is open. */
    open?: boolean;
    /** Calendar month shown when no value is selected. */
    placeholder?: DateValue;
    minValue?: DateValue;
    maxValue?: DateValue;
    isDateUnavailable?: (date: DateValue) => boolean;
    side?: Side;
    align?: Align;
    sideOffset?: number;
    collisionPadding?: number;
    /** Optional caller-owned content inside the canonical trigger Button. */
    trigger?: Snippet;
    class?: string;
    fieldClass?: string;
    segmentClass?: string;
    triggerClass?: string;
    contentClass?: string;
    calendarClass?: string;
    navigationClass?: string;
    dayClass?: string;
    onvaluechange?: (value: string) => void;
    onopenchange?: (open: boolean) => void;
  }

  let {
    label,
    calendarLabel,
    triggerLabel = `Choose ${label}`,
    name,
    value = $bindable(""),
    help,
    error,
    required = false,
    disabled = false,
    id,
    open = $bindable(false),
    placeholder,
    minValue,
    maxValue,
    isDateUnavailable,
    side,
    align,
    sideOffset,
    collisionPadding,
    trigger,
    class: className,
    fieldClass,
    segmentClass,
    triggerClass,
    contentClass,
    calendarClass,
    navigationClass,
    dayClass,
    onvaluechange,
    onopenchange,
  }: Props = $props();

  const styles = datePicker();
  const calendarValue = $derived(toDateValue(value));

  function toDateValue(candidate: string): DateValue | undefined {
    try {
      return candidate ? parseDate(candidate) : undefined;
    } catch {
      return undefined;
    }
  }

  function handleCalendarValue(next: DateValue | undefined): void {
    if (!next) return;
    value = next.toString();
    onvaluechange?.(value);
    open = false;
  }
</script>

<div class={styles.root({ class: className })} data-date-picker>
  <DateField
    {label}
    {name}
    bind:value
    {help}
    {error}
    {required}
    {disabled}
    {id}
    class={styles.field({ class: fieldClass })}
    {segmentClass}
  />
  <Popover
    {triggerLabel}
    contentLabel={calendarLabel}
    bind:open
    {disabled}
    {side}
    {align}
    {sideOffset}
    {collisionPadding}
    {trigger}
    triggerClass={styles.trigger({ class: triggerClass })}
    class={styles.content({ class: contentClass })}
    onopenchange={onopenchange}
  >
    <Calendar
      label={calendarLabel}
      value={calendarValue}
      placeholder={placeholder ?? calendarValue}
      {minValue}
      {maxValue}
      {isDateUnavailable}
      disabled={disabled}
      onvaluechange={handleCalendarValue}
      class={styles.calendar({ class: calendarClass })}
      {navigationClass}
      {dayClass}
    />
  </Popover>
</div>
