<!-- A reusable product feature relationship; page sequence and product copy stay local. -->
<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";
  import {
    MediaObject,
    SectionHeading,
    Stack,
    type SectionHeadingLevel,
  } from "@reddb-io/design-system/base";
  import {
    productFeature,
    type ProductFeatureMediaSide,
  } from "./product-feature.variants";

  interface Props extends Omit<HTMLAttributes<HTMLDivElement>, "children" | "class" | "title"> {
    title: string;
    description?: string;
    level?: SectionHeadingLevel;
    mediaSide?: ProductFeatureMediaSide;
    /** Caller-owned product imagery, including its own alternative text. */
    media: Snippet;
    children?: Snippet;
    actions?: Snippet;
    class?: string;
  }

  const instanceId = $props.id();
  const headingId = `${instanceId}-title`;
  const {
    title,
    description,
    level = 2,
    mediaSide = "start",
    media,
    children,
    actions,
    class: className,
    ...rest
  }: Props = $props();
  const slots = $derived(productFeature({ mediaSide }));
</script>

<MediaObject
  {...(rest as Record<string, unknown>)}
  data-product-feature
  role="region"
  aria-labelledby={headingId}
  {media}
  gap="lg"
  mediaClass={slots.media()}
  contentClass={slots.content()}
  class={slots.root({ class: className })}
>
  <Stack gap="lg">
    <SectionHeading
      {title}
      {description}
      {level}
      titleId={headingId}
      rule={false}
      class={slots.heading()}
    />
    {#if children}
      <div data-product-feature-body class={slots.body()}>{@render children()}</div>
    {/if}
    {#if actions}
      <div data-product-feature-actions class={slots.actions()}>{@render actions()}</div>
    {/if}
  </Stack>
</MediaObject>
