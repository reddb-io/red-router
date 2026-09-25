<!-- The one title at the root of an application page's document outline. -->
<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";
  import { Stack } from "@reddb-io/design-system/base";
  import { pageHeading } from "./page-heading.variants";

  interface Props extends Omit<HTMLAttributes<HTMLDivElement>, "class" | "title"> {
    title: string;
    description?: string;
    /** Caller-owned context such as canonical Breadcrumbs. */
    context?: Snippet;
    /** Caller-owned canonical links and controls, kept in document order. */
    actions?: Snippet;
    class?: string;
  }

  const {
    title,
    description,
    context,
    actions,
    class: className,
    ...rest
  }: Props = $props();

  const slots = $derived(pageHeading());
</script>

<div
  {...(rest as Record<string, unknown>)}
  data-page-heading
  class={slots.root({ class: className })}
>
  <Stack gap="sm" class={slots.identity()}>
    {#if context}<div data-page-heading-context class={slots.context()}>{@render context()}</div>{/if}
    <h1 class={slots.title()}>{title}</h1>
    {#if description}<p class={slots.description()}>{description}</p>{/if}
  </Stack>
  {#if actions}
    <div data-page-heading-actions class={slots.actions()}>{@render actions()}</div>
  {/if}
</div>
