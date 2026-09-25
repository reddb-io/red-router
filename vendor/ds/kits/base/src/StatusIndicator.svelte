<!--
  StatusIndicator — a Base Primitive for status at a glance.

  Colour decorates the status; it never carries it. The required label always
  remains in the document, and showLabel only decides whether sighted readers
  see that text beside the decorative mark.
-->
<script lang="ts">
  import type { HTMLAttributes } from "svelte/elements";
  import {
    statusIndicator,
    type StatusIndicatorStatus,
  } from "./status-indicator.variants";

  interface Props extends Omit<HTMLAttributes<HTMLSpanElement>, "class"> {
    /** Consumer-owned status text; this is the semantic carrier. */
    label: string;
    /** Stable DS feedback meaning. Defaults to neutral. */
    status?: StatusIndicatorStatus;
    /** Draw the label beside the mark. Hidden labels remain screen-reader text. */
    showLabel?: boolean;
    /** Extra classes, merged over the root slot. */
    class?: string;
  }

  const {
    label,
    status = "neutral",
    showLabel = true,
    class: className,
    ...rest
  }: Props = $props();
  const slots = $derived(statusIndicator({ status, labelled: showLabel }));
</script>

<span
  {...rest}
  class={slots.root({ class: className })}
  data-status-indicator
  data-status={status}
>
  <span class={slots.mark()} data-status-mark aria-hidden="true"></span>
  <span class={slots.label()} data-status-label>{label}</span>
</span>
