<!-- One expandable region, composed from Bits UI Collapsible and the canonical Button. -->
<script lang="ts">
  import type { Snippet } from "svelte";
  import { Collapsible as Bits } from "bits-ui";
  import Button from "./Button.svelte";
  import { sanitizeCollapsibleStyle } from "./collapsible.style";
  import { disclosure } from "./disclosure.variants";

  interface Props {
    label: string;
    open?: boolean;
    disabled?: boolean;
    onchange?: (open: boolean) => void;
    children?: Snippet;
    class?: string;
    triggerClass?: string;
    contentClass?: string;
  }

  let {
    label,
    open = $bindable(false),
    disabled = false,
    onchange,
    children,
    class: className,
    triggerClass,
    contentClass,
  }: Props = $props();

  const uid = $props.id();
  const triggerId = `${uid}-trigger`;
  const styles = disclosure();

  function update(next: boolean): void {
    open = next;
    onchange?.(next);
  }
</script>

<Bits.Root
  {open}
  onOpenChange={update}
  {disabled}
  data-disclosure
  class={styles.root({ class: className })}
>
  <Bits.Trigger>
    {#snippet child({ props })}
      <Button
        {...props}
        id={triggerId}
        variant="secondary"
        size="sm"
        class={styles.trigger({ class: triggerClass })}
      >
        {label}
        <span aria-hidden="true" class={styles.indicator()}>⌄</span>
      </Button>
    {/snippet}
  </Bits.Trigger>
  <Bits.Content forceMount={true}>
    {#snippet child({ props, open: contentOpen })}
      {#if contentOpen}
        <div
          {...props}
          style={sanitizeCollapsibleStyle(props.style)}
          role="region"
          aria-labelledby={triggerId}
          class={styles.content({ class: contentClass })}
        >
          {@render children?.()}
        </div>
      {/if}
    {/snippet}
  </Bits.Content>
</Bits.Root>
