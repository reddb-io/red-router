<!-- Bits UI keyboard and expanded-state behavior with canonical Button triggers. -->
<script lang="ts">
  import type { Snippet } from "svelte";
  import { Accordion as Bits } from "bits-ui";
  import Button from "./Button.svelte";
  import { sanitizeCollapsibleStyle } from "./collapsible.style";
  import { accordion, type AccordionItem } from "./accordion.variants";

  interface Props {
    /** Accessible name for the collection of sections. */
    label: string;
    items: readonly AccordionItem[];
    /** Expanded item values. Single mode retains at most one value. */
    expanded?: string[];
    multiple?: boolean;
    disabled?: boolean;
    onchange?: (value: readonly string[]) => void;
    children?: Snippet<[{ value: string }]>;
    class?: string;
    triggerClass?: string;
    contentClass?: string;
  }

  let {
    label,
    items,
    expanded = $bindable([]),
    multiple = false,
    disabled = false,
    onchange,
    children,
    class: className,
    triggerClass,
    contentClass,
  }: Props = $props();

  const uid = $props.id();
  const styles = accordion();

  function update(next: string[]): void {
    const normalized = multiple ? next : next.slice(-1);
    expanded = normalized;
    onchange?.(normalized);
  }
</script>

<Bits.Root
  type="multiple"
  value={expanded}
  onValueChange={update}
  {disabled}
  loop={true}
  data-accordion
  aria-label={label}
  class={styles.root({ class: className })}
>
  {#each items as item, index (item.value)}
    {@const triggerId = `${uid}-${index}-trigger`}
    {@const contentId = `${uid}-${index}-content`}
    <Bits.Item value={item.value} disabled={item.disabled} class={styles.item()}>
      <Bits.Header class={styles.header()}>
        <Bits.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              id={triggerId}
              aria-controls={contentId}
              variant="ghost"
              size="sm"
              class={styles.trigger({ class: triggerClass })}
            >
              <span class={styles.label()} data-accordion-label>{item.label}</span>
              <span aria-hidden="true" class={styles.indicator()}>⌄</span>
            </Button>
          {/snippet}
        </Bits.Trigger>
      </Bits.Header>
      <Bits.Content>
        {#snippet child({ props })}
          <div
            {...props}
            style={sanitizeCollapsibleStyle(props.style)}
            id={contentId}
            role="region"
            aria-labelledby={triggerId}
            class={styles.content({ class: contentClass })}
          >
            {@render children?.({ value: item.value })}
          </div>
        {/snippet}
      </Bits.Content>
    </Bits.Item>
  {/each}
</Bits.Root>
