<!-- Product detail inside the canonical Dialog focus and dismissal lifecycle. -->
<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";
  import { Dialog } from "@reddb-io/design-system/base";
  import { productQuickview } from "./product-quickview.variants";

  interface Props extends Omit<HTMLAttributes<HTMLDivElement>, "children" | "class" | "title"> {
    triggerLabel: string;
    title: string;
    description?: string;
    trigger?: Snippet;
    /** Caller-owned product imagery, including its own alternative text. */
    media?: Snippet;
    /** Caller-owned product detail and controls. */
    children?: Snippet;
    actions?: Snippet<[{ close: () => void }]>;
    class?: string;
    dialogClass?: string;
  }

  const {
    triggerLabel,
    title,
    description,
    trigger,
    media,
    children,
    actions,
    class: className,
    dialogClass,
    ...rest
  }: Props = $props();
  const slots = $derived(productQuickview());
</script>

<div
  {...(rest as Record<string, unknown>)}
  data-product-quickview
  class={slots.root({ class: className })}
>
  <Dialog
    {triggerLabel}
    {title}
    {description}
    {trigger}
    {actions}
    initialFocus="body"
    class={slots.dialog({ class: dialogClass })}
  >
    <div data-product-quickview-content class={slots.content()}>
      {#if media}
        <div data-product-quickview-media class={slots.media()}>{@render media()}</div>
      {/if}
      <div data-product-quickview-body class={slots.body()}>{@render children?.()}</div>
    </div>
  </Dialog>
</div>
