<!--
  Badge — a Base Primitive for a short status marker inside running text.

  Emphasis is appearance, not meaning: caller-owned text is required and is
  always rendered. The span has no interaction of its own; a pressed or linked
  badge is the corresponding native control wearing the exported badge classes.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";
  import { badge, type BadgeVariant } from "./badge.variants";

  interface Props extends Omit<HTMLAttributes<HTMLSpanElement>, "class"> {
    /** Status text; required so emphasis can never be the whole message. */
    children: Snippet;
    /** Visual emphasis. Defaults to neutral. */
    variant?: BadgeVariant;
    /** Extra classes, merged over the canonical appearance. */
    class?: string;
  }

  const {
    variant = "neutral",
    class: className,
    children,
    ...rest
  }: Props = $props();
</script>

<span {...rest} class={badge({ variant, class: className })} data-badge>
  {@render children()}
</span>
