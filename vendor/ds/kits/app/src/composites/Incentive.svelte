<!-- One caller-authored value proposition over canonical media and heading contracts. -->
<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";
  import {
    MediaObject,
    SectionHeading,
    type SectionHeadingLevel,
  } from "@reddb-io/design-system/base";
  import { incentive } from "./incentive.variants";

  interface Props extends Omit<HTMLAttributes<HTMLDivElement>, "children" | "class" | "title"> {
    title: string;
    description?: string;
    level?: SectionHeadingLevel;
    /** Decorative caller-owned artwork; the visible title carries the proposition's meaning. */
    icon: Snippet;
    actions?: Snippet;
    class?: string;
  }

  const instanceId = $props.id();
  const headingId = `${instanceId}-title`;
  const {
    title,
    description,
    level = 2,
    icon,
    actions,
    class: className,
    ...rest
  }: Props = $props();
  const slots = incentive();
</script>

{#snippet incentiveIcon()}
  <div data-incentive-icon aria-hidden="true" class={slots.icon()}>{@render icon()}</div>
{/snippet}

<MediaObject
  {...(rest as Record<string, unknown>)}
  data-incentive
  role="region"
  aria-labelledby={headingId}
  media={incentiveIcon}
  align="start"
  gap="md"
  contentClass={slots.content()}
  class={slots.root({ class: className })}
>
  <SectionHeading
    {title}
    {description}
    {level}
    {actions}
    titleId={headingId}
    size="sm"
    rule={false}
    class={slots.heading()}
  />
</MediaObject>
