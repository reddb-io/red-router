<!-- A single-date calendar composing Bits UI behavior with canonical Base Button controls. -->
<script lang="ts">
  import type { DateValue } from "@internationalized/date";
  import { Calendar as Bits } from "bits-ui";
  import Button from "./Button.svelte";
  import { calendar } from "./calendar.variants";

  type RootProps = Extract<Bits.RootProps, { type: "single" }>;
  type Props = Omit<
    RootProps,
    | "calendarLabel"
    | "child"
    | "children"
    | "class"
    | "onPlaceholderChange"
    | "onValueChange"
    | "placeholder"
    | "type"
    | "value"
  > & {
    /** Base accessible name; the visible month and year are appended by the calendar. */
    label: string;
    value?: DateValue;
    placeholder?: DateValue;
    onvaluechange?: (value: DateValue | undefined) => void;
    onplaceholderchange?: (value: DateValue) => void;
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
    class: className,
    navigationClass,
    dayClass,
    ...rest
  }: Props = $props();

  const styles = calendar();
</script>

<Bits.Root
  {...rest}
  type="single"
  calendarLabel={label}
  {weekdayFormat}
  {fixedWeeks}
  bind:value
  bind:placeholder
  onValueChange={onvaluechange}
  onPlaceholderChange={onplaceholderchange}
  data-calendar
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
