<!-- One category destination over canonical Card, AspectRatio, and Link contracts. -->
<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";
  import { AspectRatio, Card, Link } from "@reddb-io/design-system/base";
  import { categoryPreview } from "./category-preview.variants";

  interface Props extends Omit<HTMLAttributes<HTMLDivElement>, "children" | "class"> {
    /** Visible category name and the destination's accessible name. */
    name: string;
    href: string;
    description?: string;
    /** Caller-owned category imagery, including its own alternative text. */
    media: Snippet;
    ratio?: number;
    class?: string;
  }

  const instanceId = $props.id();
  const linkId = `${instanceId}-link`;
  const {
    name,
    href,
    description,
    media,
    ratio = 4 / 3,
    class: className,
    ...rest
  }: Props = $props();
  const slots = categoryPreview();
</script>

<Card
  {...(rest as Record<string, unknown>)}
  data-category-preview
  role="article"
  aria-labelledby={linkId}
  variant="plain"
  padding="none"
  class={slots.root({ class: className })}
>
  <AspectRatio {ratio} class={slots.media()}>{@render media()}</AspectRatio>
  <div data-category-preview-content class={slots.content()}>
    <h3 class={slots.name()}><Link id={linkId} {href}>{name}</Link></h3>
    {#if description}<p class={slots.description()}>{description}</p>{/if}
  </div>
</Card>
