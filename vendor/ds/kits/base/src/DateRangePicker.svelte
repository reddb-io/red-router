<!-- Synchronized DateRangeField and RangeCalendar under the canonical Popover lifecycle. -->
<script lang="ts">
  import { parseDate, type DateValue } from "@internationalized/date";
  import type { Snippet } from "svelte";
  import DateRangeField from "./DateRangeField.svelte";
  import Popover from "./Popover.svelte";
  import RangeCalendar from "./RangeCalendar.svelte";
  import { dateRangePicker } from "./date-range-picker.variants";

  type DateRange = { start: DateValue | undefined; end: DateValue | undefined };
  type StringDateRange = { start: string; end: string };
  type Side = "top" | "right" | "bottom" | "left";
  type Align = "start" | "center" | "end";

  interface Props {
    /** Visible legend naming the related DateFields. */
    label: string;
    startLabel: string;
    endLabel: string;
    /** Accessible name for the RangeCalendar grid and Popover dialog. */
    calendarLabel: string;
    triggerLabel?: string;
    startName?: string;
    endName?: string;
    /** Complete ISO bounds shared by DateRangeField and RangeCalendar. */
    startValue?: string;
    endValue?: string;
    help?: string;
    rangeError?: string;
    required?: boolean;
    disabled?: boolean;
    id?: string;
    open?: boolean;
    placeholder?: DateValue;
    minValue?: DateValue;
    maxValue?: DateValue;
    minDays?: number;
    maxDays?: number;
    isDateUnavailable?: (date: DateValue) => boolean;
    side?: Side;
    align?: Align;
    sideOffset?: number;
    collisionPadding?: number;
    trigger?: Snippet;
    class?: string;
    fieldClass?: string;
    dateFieldClass?: string;
    segmentClass?: string;
    triggerClass?: string;
    contentClass?: string;
    calendarClass?: string;
    navigationClass?: string;
    dayClass?: string;
    onvaluechange?: (value: StringDateRange) => void;
    onopenchange?: (open: boolean) => void;
  }

  let {
    label,
    startLabel,
    endLabel,
    calendarLabel,
    triggerLabel = `Choose ${label}`,
    startName,
    endName,
    startValue = $bindable(""),
    endValue = $bindable(""),
    help,
    rangeError,
    required = false,
    disabled = false,
    id,
    open = $bindable(false),
    placeholder,
    minValue,
    maxValue,
    minDays,
    maxDays,
    isDateUnavailable,
    side,
    align,
    sideOffset,
    collisionPadding,
    trigger,
    class: className,
    fieldClass,
    dateFieldClass,
    segmentClass,
    triggerClass,
    contentClass,
    calendarClass,
    navigationClass,
    dayClass,
    onvaluechange,
    onopenchange,
  }: Props = $props();

  const styles = dateRangePicker();
  const calendarValue = $derived<DateRange>({
    start: toDateValue(startValue),
    end: toDateValue(endValue),
  });

  function toDateValue(candidate: string): DateValue | undefined {
    try {
      return candidate ? parseDate(candidate) : undefined;
    } catch {
      return undefined;
    }
  }

  function handleCalendarValue(next: DateRange): void {
    startValue = next.start?.toString() ?? "";
    endValue = next.end?.toString() ?? "";

    if (startValue && endValue) {
      onvaluechange?.({ start: startValue, end: endValue });
      open = false;
    }
  }
</script>

<div class={styles.root({ class: className })} data-date-range-picker>
  <DateRangeField
    {label}
    {startLabel}
    {endLabel}
    {startName}
    {endName}
    bind:startValue
    bind:endValue
    {help}
    {rangeError}
    {required}
    {disabled}
    {id}
    class={styles.field({ class: fieldClass })}
    fieldClass={dateFieldClass}
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
    class={contentClass}
    onopenchange={onopenchange}
  >
    <RangeCalendar
      label={calendarLabel}
      value={calendarValue}
      placeholder={placeholder ?? calendarValue.start}
      {minValue}
      {maxValue}
      {minDays}
      {maxDays}
      {isDateUnavailable}
      {disabled}
      onvaluechange={handleCalendarValue}
      class={styles.calendar({ class: calendarClass })}
      {navigationClass}
      {dayClass}
    />
  </Popover>
</div>
