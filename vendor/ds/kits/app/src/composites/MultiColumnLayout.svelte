<!--
  A structural two- or three-column arrangement. Each region is the canonical
  Base Stack, so its vertical rhythm remains live under the nearest Density.
  The regions deliberately introduce no landmarks: semantics belong to the
  content a consumer puts in them.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";
  import { Stack, type StackGap } from "@reddb-io/design-system/base";
  import { multiColumnLayout } from "./multi-column-layout.variants";

  interface Props extends Omit<HTMLAttributes<HTMLDivElement>, "class"> {
    /** Leading column content. */
    start?: Snippet;
    /** Primary column content. */
    children?: Snippet;
    /** Optional trailing column; its presence selects the three-column form. */
    end?: Snippet;
    /** Vertical rhythm inside every column. */
    gap?: StackGap;
    /** Extra classes merged onto the responsive grid. */
    class?: string;
  }

  let {
    start,
    children,
    end,
    gap = "md",
    class: className,
    ...rest
  }: Props = $props();

  const columns = $derived(end ? "three" : "two");
  const slots = $derived(multiColumnLayout({ columns }));
</script>

<div
  {...(rest as Record<string, unknown>)}
  data-multi-column-layout
  data-columns={columns}
  class={slots.root({ class: className })}
>
  <Stack {gap} class={slots.column()} data-column="start">{@render start?.()}</Stack>
  <Stack {gap} class={slots.column()} data-column="main">{@render children?.()}</Stack>
  {#if end}
    <Stack {gap} class={slots.column()} data-column="end">{@render end()}</Stack>
  {/if}
</div>
