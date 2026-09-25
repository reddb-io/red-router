<!-- A date-range calendar sharing Calendar appearance while Bits UI owns range behavior. -->
<script lang="ts">
  import type { DateValue } from "@internationalized/date";
  import { RangeCalendar as Bits } from "bits-ui";
  import Button from "./Button.svelte";
  import { calendar } from "./calendar.variants";

  type DateRange = NonNullable<Bits.RootProps["value"]>;
  type Props = Omit<
    Bits.RootProps,
    | "calendarLabel"
    | "child"
    | "children"
    | "class"
    | "onEndValueChange"
    | "onPlaceholderChange"
    | "onStartValueChange"
    | "onValueChange"
    | "placeholder"
    | "value"
  > & {
    /** Base accessible name; the visible month and year are appended by the calendar. */
    label: string;
    value?: DateRange;
    placeholder?: DateValue;
    onvaluechange?: (value: DateRange) => void;
    onplaceholderchange?: (value: DateValue) => void;
    onstartvaluechange?: (value: DateValue | undefined) => void;
    onendvaluechange?: (value: DateValue | undefined) => void;
    class?: string;
    navigationClass?: string;
    dayClass?: string;
  };

  let {
    label,
    value = $bindable(),
    placeholder = $bindable(),
    weekdayFormat = "short",
    fixedWeeks = true,
    onvaluechange,
    onplaceholderchange,
    onstartvaluechange,
    onendvaluechange,
    class: className,
    navigationClass,
    dayClass,
    ...rest
  }: Props = $props();

  const styles = calendar();
</script>

<Bits.Root
  {...rest}
  calendarLabel={label}
  {weekdayFormat}
  {fixedWeeks}
  bind:value
  bind:placeholder
  onValueChange={onvaluechange}
  onPlaceholderChange={onplaceholderchange}
  onStartValueChange={onstartvaluechange}
  onEndValueChange={onendvaluechange}
  data-range-calendar
  class={styles.root({ class: className })}
>
  {#snippet children({ months, weekdays })}
    <Bits.Header class={styles.header()}>
      <Bits.PrevButton>
        {#snippet child({ props })}
          <Button
            {...props}
            variant="ghost"
            size="sm"
            aria-label="Previous month"
            class={styles.navigation({ class: navigationClass })}
          >
            <span aria-hidden="true">←</span>
          </Button>
        {/snippet}
      </Bits.PrevButton>
      <Bits.Heading class={styles.heading()} />
      <Bits.NextButton>
        {#snippet child({ props })}
          <Button
            {...props}
            variant="ghost"
            size="sm"
            aria-label="Next month"
            class={styles.navigation({ class: navigationClass })}
          >
            <span aria-hidden="true">→</span>
          </Button>
        {/snippet}
      </Bits.NextButton>
    </Bits.Header>

    <div class={styles.months()}>
      {#each months as month}
        <Bits.Grid class={styles.grid()}>
          <Bits.GridHead class={styles.gridHead()}>
            <Bits.GridRow class={styles.gridRow()}>
              {#each weekdays as weekday, index (index)}
                <Bits.HeadCell class={styles.headCell()}>{weekday}</Bits.HeadCell>
              {/each}
            </Bits.GridRow>
          </Bits.GridHead>
          <Bits.GridBody>
            {#each month.weeks as weekDates, weekIndex (weekIndex)}
              <Bits.GridRow class={styles.gridRow()}>
                {#each weekDates as date (date.toString())}
                  <Bits.Cell {date} month={month.value} class={styles.cell()}>
                    <Bits.Day class={styles.day({ class: dayClass })} />
                  </Bits.Cell>
                {/each}
              </Bits.GridRow>
            {/each}
          </Bits.GridBody>
        </Bits.Grid>
      {/each}
    </div>
  {/snippet}
</Bits.Root>
