<!-- A section title whose outline depth and visual size are separate decisions. -->
<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";
  import {
    sectionHeading,
    type SectionHeadingLevel,
    type SectionHeadingSize,
  } from "./section-heading.variants";

  interface Props extends Omit<HTMLAttributes<HTMLElement>, "class" | "title"> {
    title: string;
    description?: string;
    /** Optional id for the rendered heading, for an enclosing landmark's aria-labelledby. */
    titleId?: string;
    level?: SectionHeadingLevel;
    size?: SectionHeadingSize;
    rule?: boolean;
    actions?: Snippet;
    class?: string;
  }

  const {
    title,
    description,
    titleId,
    level = 2,
    size = "md",
    rule = true,
    actions,
    class: className,
    ...rest
  }: Props = $props();

  const slots = $derived(sectionHeading({ size, rule }));
</script>

<div {...rest} data-section-heading class={slots.root({ class: className })}>
  <div class={slots.text()}>
    <svelte:element this={`h${level}`} id={titleId} data-section-heading-title class={slots.title()}>{title}</svelte:element>
    {#if description}<p data-section-heading-description class={slots.description()}>{description}</p>{/if}
  </div>
  {#if actions}
    <div class={slots.actions()}>{@render actions()}</div>
  {/if}
</div>
