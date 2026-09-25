<!-- A compact card title over the canonical section-heading outline contract. -->
<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";
  import {
    SectionHeading,
    type SectionHeadingLevel,
    type SectionHeadingSize,
  } from "@reddb-io/design-system/base";
  import { cardHeading } from "./card-heading.variants";

  interface Props extends Omit<HTMLAttributes<HTMLDivElement>, "class" | "title"> {
    title: string;
    description?: string;
    level?: SectionHeadingLevel;
    size?: SectionHeadingSize;
    actions?: Snippet;
    class?: string;
  }

  const {
    title,
    description,
    level = 2,
    size = "sm",
    actions,
    class: className,
    ...rest
  }: Props = $props();
</script>

<SectionHeading
  {...(rest as Record<string, unknown>)}
  data-card-heading
  {title}
  {description}
  {level}
  {size}
  rule={false}
  {actions}
  class={cardHeading({ class: className })}
/>
